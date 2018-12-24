const {MediaServer} = require("./MediaServer");
const {wrap, wrapNoErr} = require('../../lib/async');
const Global = require("../../lib/global")();
const upnp = require('../../lib/upnp');
const entities = require('entities');
const { sprintf } = require('sprintf-js');

function upnpClassFromItem(item) {
    if (item.type === 'container') {
        switch (item.mediatype) {
            case 'show':
            case 'season':
                return 'object.container.album.videoAlbum';
            default:
                return 'object.container';
        }
    } else if (item.type === 'file') {
        switch (item.mimetype && item.mimetype.split('/')[0]) {
            case 'video':
                switch (item.mediatype) {
                    case 'movie':
                        return 'object.item.videoItem.movie';
                    case 'episode':
                        if(item.unavailable)
                            return 'object.item.epgItem.videoProgram';
                        else
                            return 'object.item.videoItem.videoBroadcast';
                    default:
                        return 'object.item.videoItem';
                }
            case 'image':
                return 'object.item.imageItem';
            case 'audio':
                return 'object.item.musicItem';
            default:
                return 'object.item';
        }
    } else {
        throw `Item type ${item.type} missing or not implemented`;
    }
}

class MediaServerDelegate {
    constructor(pith) {
        this.pith = pith;
    }

    async fetchChildren(id, opts) {
        if (id == 0) {
            let channels = await wrapNoErr(cb => this.pith.listChannels(cb));
            let items = channels.map(channel => ({
                id: `channel:${channel.id}`,
                parentId: 0,
                updateId: 0,
                type: 'container',
                properties: {
                    "dc:title": channel.title,
                    "upnp:class": "object.container"
                }
            }));
            return {
                updateId: 0,
                items: items,
                totalItems: items.length
            };
        } else {
            let [, channelId, , itemId] = id.match(/^channel:(\w+)(:(.*))?$/);
            let channel = this.pith.getChannelInstance(channelId);
            let contents = await channel.listContents(itemId);
            let items = contents.filter(item => !item.unavailable).map(item => this.mapObject(channel, item, id, channelId));
            return {
                updateId: 0,
                items: items,
                totalItems: items.length
            };
        }
    }

    mapObject(channel, item, parentId, channelId) {
        return ({
            id: `channel:${channel.id}:${item.id}`,
            parentId: item.parentId ? `channel:${channel.id}:${item.parentId}` : parentId,
            updateId: 0,
            type: item.type === 'container' ? 'container' : 'item',
            properties: this.toDidl(item),
            resources: [
                item.playable && {
                    uri: `${Global.rootUrl}/rest/channel/${channelId}/redirect/${encodeURIComponent(item.id)}`,
                    protocolInfo: `http-get:*:${item.mimetype}:DLNA.ORG_OP=01;DLNA.ORG_CI=0`
                },
                item.poster ? {
                    uri: entities.encodeXML(item.poster),
                    protocolInfo: "xbmc.org:*:poster:*"
                } : undefined,
                item.backdrop ? {
                    uri: entities.encodeXML(item.backdrop),
                    protocolInfo: "xbmc.org:*:fanart:*"
                } : undefined
            ]
        });
    }

    toDidl(item) {
        let coverArt = item.thumb || item.poster;

        let didl = {
            "dc:title": item.title,
            "upnp:class": upnpClassFromItem(item),
            "dc:date": upnp.formatDate(item.airDate) || upnp.formatDate(item.releaseDate) || (item.year && `${item.year}-01-01`) || undefined,
            "upnp:genre": item.genres,
            "upnp:author": item.writers,
            "upnp:director": item.director,
            "upnp:longDescription": item.plot,
            "xbmc:dateadded": item.creationTime,
            "xbmc:rating": item.tmdbRating,
            "xbmc:votes": item.tmdbVoteCount,
            "xbmc:uniqueIdentifier": item.imdbId,
            "upnp:lastPlaybackTime": "",
            "upnp:playbackCount": (item.playState && item.playState.status == 'watched' ? 1 : 0),
            "upnp:lastPlaybackPosition": (item.playState && item.playState.time),
            "xbmc:artwork": [
                item.backdrop ? {_attribs: {type: "fanart"}, _value: item.backdrop} : undefined,
                item.poster ? {_attribs: {type: "poster"}, _value: item.poster} : undefined,
                item.banner ? {_attribs: {type: "banner"}, _value: item.banner} : undefined
            ],
            "upnp:albumArtURI": coverArt && [
                {
                    _attribs: {"dlna:profileID": "JPEG_TN"},
                    _value: `${Global.rootUrl}/scale/${coverArt}?size=160x160&format=jpg`
                },{
                    _attribs: {"dlna:profileID": "JPEG_SM"},
                    _value: `${Global.rootUrl}/scale/${coverArt}?size=640x480&format=jpg`
                },{
                    _attribs: {"dlna:profileID": "JPEG_MED"},
                    _value: `${Global.rootUrl}/scale/${coverArt}?size=1024x768&format=jpg`
                }
            ]
        };

        switch(item.mediatype) {
            case 'episode':
                Object.assign(didl, {
                    // "dc:publisher": "",
                    "dc:title": `S${ item.season }E${ item.episode } : ${ item.title }`,
                    "upnp:programTitle": `S${ item.season }E${ item.episode } : ${ item.title }`,
                    "upnp:seriesTitle": item.showname,
                    "upnp:episodeNumber": sprintf('%02d%02d', item.season, item.episode),
                    "upnp:episodeSeason": 0
                });
                break;
            case 'season':
                Object.assign(didl, {
                    // "dc:publisher": "",
                    "upnp:seriesTitle": item.showname,
                    "upnp:episodeNumber": item.noEpisodes,
                    "upnp:episodeSeason": 0
                });
                break;
            case 'show':
                Object.assign(didl, {
                    // "dc:publisher": "",
                    "upnp:episodeNumber": item.noEpisodes
                });
                break;
        }

        return didl;
    }

    async fetchObject(id) {
        console.debug(`fetchObject for ${id}`);
        let [, channelId, , itemId] = id.match(/^channel:(\w+)(:(.*))?$/);
        if (itemId) {
            let channel = this.pith.getChannelInstance(channelId);
            let contents = await channel.getItem(itemId);
            let item = this.mapObject(channel, contents, id, channelId);
            return {
                updateId: 0,
                item: item
            };
        }
    }
}

module.exports = {
    init(opts) {
        let mediaserver = new MediaServer({
            name: 'MediaServer',
            address: Global.bindAddress,
            delegate: new MediaServerDelegate(opts.pith),
            uuid: Global.persistentUuid('MediaServer')
        });
        mediaserver.on('ready', () => {
            mediaserver.ssdpAnnounce();
        })
    }
};