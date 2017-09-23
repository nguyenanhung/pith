var fs = require("fs");
var mimetypes = require("../../lib/mimetypes");
var vidstreamer = require("../../lib/vidstreamer");
var async = require("async");
var $path = require("path");
var settings = require("../../lib/global")().settings;
var playstate = require("./playstate");
var ff = require("fluent-ffmpeg");
var Channel = require("../../lib/channel");
var wrapToPromise = require("../../lib/util").wrapToPromise;
var profiles = require("../../lib/profiles");

var metaDataProviders = [
    require("./movie-nfo"),
//    require("./tvshow-nfo"),
    require("./thumbnails"),
    require("./fanart")
];

function FilesChannel(pith, statestore) {
    Channel.apply(this);

    this.rootDir = settings.files.rootDir;
    this.pith = pith;
    
    var channel = this;
    
    this.statestore = statestore;
    
    vidstreamer.settings({
        getFile: function(path, cb) {
            cb(channel.getFile(path));
        }
    });
    
    pith.handle.use('/stream', vidstreamer);
}

FilesChannel.prototype = {
    listContents: function(containerId) {
        return wrapToPromise(cb => {
            var rootDir = this.rootDir, path;
            if(containerId) {
                path = $path.resolve(rootDir, containerId);
            } else {
                path = rootDir;
            }

            var filesChannel = this;

            fs.readdir(path, function(err, files) {
                if(err) {
                    cb(err);
                } else {
                    async.map(files.filter(function(e) {
                        return (e[0] != "." || settings.files.showHiddenFiles) && settings.files.excludeExtensions.indexOf($path.extname(e)) == -1;
                    }), function(file, cb) {
                        var filepath = $path.resolve(path, file);
                        var itemId = $path.relative(rootDir, filepath);
                        filesChannel.getItem(itemId, false).then(function(item) {
                            cb(false, item);
                        }).catch(cb);
                    }, function(err, contents) {
                        cb(err, contents.filter(function(e) { return e !== undefined; }));
                    });
                }
            });
        });
    },

    getFile: function(path, cb) {
        return $path.resolve(this.rootDir, path);
    },
    
    getItem: function(itemId, detailed) {
        return new Promise((resolve, reject) => {
            if(arguments.length == 1) {
                detailed = true;
            }

            var filepath = $path.resolve(this.rootDir, itemId);
            var channel = this;
            fs.stat(filepath, function(err, stats) {
                var item = {
                    title: $path.basename(itemId),
                    id: itemId
                };

                if(stats && stats.isDirectory()) {
                    item.type = 'container';
                } else {
                    item.type = 'file';
                    var extension = $path.extname(itemId);
                    item.mimetype = mimetypes[extension];
                    item.playable = item.mimetype && true;

                    item.fileSize = stats && stats.size;
                    item.modificationTime = stats && stats.mtime;
                    item.creationTime = stats && stats.ctime;
                    item.fsPath = filepath;
                }

                var applicableProviders = metaDataProviders.filter(function(f) {
                    return f.appliesTo(channel, filepath, item);
                });

                if(applicableProviders.length) {
                    async.parallel(applicableProviders.map(function(f) {
                        return function(cb) {
                            f.get(channel, filepath, item, cb);
                        };
                    }), function() {
                        resolve(item);
                    });
                } else {
                    resolve(item);
                }
            });
        });
    },
    
    getStream: function(item, options) {
        return new Promise((resolve, reject) => {
            var channel = this;
            var itemId = item.id;
            var itemPath = itemId.split($path.sep).map(encodeURIComponent).join("/");
            ff.ffprobe(this.getFile(item.id), function(err, metadata) {
                if(err) {
                    reject(err);
                } else {
                    let duration = parseFloat(metadata.format.duration) * 1000;

                    var desc = {
                        url: channel.pith.rootUrl + "stream/" + itemPath,
                        mimetype: item.mimetype,
                        seekable: true,
                        format: {
                            container: metadata.format.tags.major_brand,
                            streams: metadata.streams.map(stream => ({
                                index: stream.index,
                                codec: stream.codec_name,
                                profile: stream.profile,
                                pixelFormat: stream.pix_fmt
                            }))
                        },
                        duration: duration
                    };

                    if(options && options.target) {
                        desc.streams = options.target.split(",").map((profileName) => {
                            let profile = profiles[profileName];
                            let url = `${channel.pith.rootUrl}stream/${itemPath}?transcode=${profileName}`;
                            if(profile.requiresPlaylist) {
                                url += `&playlist=${profile.requiresPlaylist}`;
                            }

                            return {
                                url: url,
                                mimetype: profile.mimetype,
                                seekable: profile.seekable,
                                duration: duration
                            };
                        });
                    }

                    resolve(desc);
                }
            });
        });
    },
    
    getLastPlayState: function(itemId) {
        var state = this.statestore.get(itemId);
        return Promise.resolve(state);
    },

    getLastPlayStateFromItem: function(item) {
        return this.getLastPlayState(item.id);
    },
    
    putPlayState: function(itemId, state) {
        try {
            state.id = itemId;
            this.statestore.put(state);
            return Promise.resolve();
        } catch(e) {
            return Promise.reject(e);
        }
    },

    resolveFile: function(file) {
        if(file.startsWith(this.rootDir)) {
            var relative = file.substring(this.rootDir.length);
            if(relative.startsWith('/')) {
                relative = relative.substring(1);
            }
            return this.getItem(relative);
        } else {
            return Promise.reject("File not contained within media root");
        }
    }
};

module.exports = {
    init: function(opts) {
        playstate(opts.pith.db, function(err, statestore) {
            opts.pith.registerChannel({
                id: 'files',
                title: 'Files',
                type: 'channel',
                init: function(opts) {
                    return new FilesChannel(opts.pith, statestore);
                },
                sequence: 0
            });
        });
    },

    metaDataProviders: metaDataProviders
};
