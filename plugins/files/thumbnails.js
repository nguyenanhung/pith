var fs = require("fs");
var $path = require("path");

module.exports = {
    appliesTo: function(channel, filepath, item) {
        return item.type == 'file';
    },
    get: function findThumbnails(channel, filepath, item, cb) {
        var tbnFile = filepath.replace(/\.[^.\/]*$/, ".tbn");
        fs.exists(tbnFile, function(exists) {
            if(exists) {
                var path = channel.rootDir;
                var matchRootDir = new RegExp("^" + path);
                var itemPath = tbnFile.replace(matchRootDir, '').split($path.sep).map(encodeURIComponent).join("/");
                item.thumbnail = channel.pith.rootPath + "/stream/" + itemPath;
                cb();
            } else {
                tbnFile = $path.join($path.dirname(filepath), "movie.tbn");
                fs.exists(tbnFile, function(exists) {
                   if(exists) {
                       var path = channel.rootDir;
                       var matchRootDir = new RegExp("^" + path);
                       var itemPath = tbnFile.replace(matchRootDir, '').split($path.sep).map(encodeURIComponent).join("/");
                       item.thumbnail = channel.pith.rootPath + "/stream/" + itemPath;
                   } else if(item.mimetype && item.mimetype.startsWith("video")) {
                       item.still = channel.pith.rootPath + "/preview/" + item.id.split($path.sep).map(encodeURIComponent).join("/") + "/0:10:00.jpg";
                   }
                   cb();
                });
            }
        });
    }
}