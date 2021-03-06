var irc = require('irc');
var printf = require('printf');
var keyHandler = require('./keyHandler.js');
var config = require('./config.js');
var OBSRemote = require('obs-remote');
var obs = new OBSRemote();
var Promise = require('bluebird');
var exec = Promise.promisify(require('child_process').exec);
var EventEmitter = require('events').EventEmitter;
var events = new EventEmitter();
var whitelist = require('../services/whitelist.js');
var blacklist = require('../services/blacklist.js');

var client = new irc.Client(config.server, config.nick, {
    channels: [config.channel],
    port: config.port || 6667,
    sasl: false,
    nick: config.nick,
    userName: config.nick,
    password: config.password,
    //This has to be false, since SSL in NOT supported by twitch IRC (anymore?)
    // see: http://help.twitch.tv/customer/portal/articles/1302780-twitch-irc
    secure: false,
    floodProtection: config.floodProtection || false,
    floodProtectionDelay: config.floodProtectionDelay || 100,
    autoConnect: false,
    autoRejoin: true
});

var commandRegexes = [];
Object.keys(config.commands).forEach(function (k) {
    var regexp = config.commands[k];
    commandRegexes.push({ re: regexp, command: k });
});

var specialCommandRegexes = [];
Object.keys(config.specialCommands).forEach(function (k) {
    var regexp = config.specialCommands[k];
    specialCommandRegexes.push({ re: regexp, command: k });
});

var streaming = false;
if (config.obsRemoteEnable) {
    var retries = 3;
    var retryNum = 1;
    obs.onAuthenticationSucceeded = function () {
        console.log('Authenticated with OBSRemote.');
        obs.getStreamingStatus(function(isStreaming) {
            streaming = isStreaming;
            console.log('Stream is currently', isStreaming ? 'LIVE' : 'OFF');
        });
    };
    obs.onConnectionOpened = function () {
        console.log('OBSRemote connection opened.');
    };
    obs.onAuthenticationFailed = function () {
        console.log('OBSRemote authentication failed.');
    };
    obs.onStreamStopped = function () {
        console.log('OBS Stream stopped.');
        streaming = false;
    };
    obs.onStreamStarted = function () {
        console.log('OBS Stream started.');
        streaming = true;
    };
    obs.onConnectionFailed = function () {
        if (retryNum >= retries) {
            console.log('OBSRemote connection failed. Not retrying.');
        } else {
            console.log('OBSRemote connection failed, retrying', retryNum++, 'of', retries);
            obs.connect(config.obsRemoteServer, config.obsRemotePw);
        }
    };
    obs.onConnectionClosed = function () {
        console.log('OBSRemote connection closed.');
    };
    obs.connect(config.obsRemoteServer, config.obsRemotePw);
    console.log('Connecting to OBSRemote...');
}

if (config.overlayConnectionEnable) {
    console.log("Attempting to connect to overlay server at " + config.overlayHost + ':' + config.overlayPort + '/server');
    var io = require('socket.io-client')(config.overlayHost + ':' + config.overlayPort + '/server');
    io.on('connect', function () {
        console.log('Server connected to overlay server socket.');
        events.on('message', function (data) {
            io.emit('message', data);
        });
        events.on('command', function (data) {
            io.emit('command', data);
        });
        events.on('vote', function (data) {
            io.emit('vote', data);
        });
        events.on('repeatToggle', function (data) {
            io.emit('repeatToggle', data);
        });
    });
}

function isWindowAlive() {
    return exec('autohotkey ./app/windowalive.ahk');
}

function stopEverything() {
    if (streaming) {
        obs.toggleStream();
        streaming = false;
    }
}

client.addListener('message' + config.channel, function(from, message) {
    var match = null;
    var command = null;
    if (!blacklist.isBlacklisted(from) && commandRegexes.some(function (item) {
        match = message.match(item.re);
        if (match) {
            command = item.command;
        }
        return !!match;
    })) {
        if (config.printToConsole) {
            //format console output if needed
            var maxName = config.maxCharName,
            maxCommand = config.maxCharCommand,
            logFrom = from.substring(0, maxName),
            logMessage = message.substring(0, maxCommand);
            //format log
            console.log(printf('%-' + maxName + 's % ' + maxCommand + 's',
                logFrom, logMessage));
        }

        var queued = keyHandler.queueCommand(command, match);
        if (queued) {
            events.emit('vote', { count: queued.count, id: queued.commandId, description: queued.action.desc, group: queued.action.group });
        }
    }
    events.emit('message', { name: from, message: message, match: !!match });
});

client.addListener('message' + config.channel, function(from, message) {
    // handle special commands
    if (!whitelist.isWhitelisted(from) && !whitelist.hasAdminPermission(from)) {
        return;
    }

    var match = null;
    var command = null;
    if (specialCommandRegexes.some(function (item) {
        match = message.match(item.re);
        if (match) {
            command = item.command;
        }
        return !!match;
    })) {
        switch (command) {
            case 'ban':
                blacklist.add(match[1]);
                client.say(config.channel, match[1] + ' added to blacklist; they can no longer perform commands until you !unban them.');
                break;
            case 'unban':
                blacklist.remove(match[1]);
                client.say(config.channel, match[1] + ' removed from blacklist; they can now run commands.');
                break;
            case 'whitelist':
                if (whitelist.hasAdminPermission(from)) {
                    whitelist.add(match[1]);
                    client.say(config.channel, match[1] + ' whitelisted for mod commands.');
                }
                break;
            case 'whitelistremove':
                if (whitelist.hasAdminPermission(from)) {
                    whitelist.remove(match[1]);
                    client.say(config.channel, match[1] + ' removed from whitelist.');
                }
                break;
            default:
                return;
        }
    }
});

client.addListener('error', function(message) {
    console.log('error: ', message);
});

client.addListener('registered', function () {
    console.log('Connected!');
    serverKeepalive();
});

var pongTimeout;
client.addListener('pong', function () {
    // if we get a response to a ping, clear the timer we have set to reconnect
    clearTimeout(pongTimeout);
    pongTimeout = undefined;
});

var keepAliveInterval;
function serverKeepalive() {
    function sendPing() {
        clearTimeout(pongTimeout);
        pongTimeout = setTimeout(function () {
            // reconnect if we dont get a pong reply fast enough
            try {
                client.connect();
            } catch (e) {
                console.log(e);
            }
        }, 5 * 60 * 1000);
        client.send('PING', 'empty');
    }
    clearInterval(keepAliveInterval);
    clearTimeout(pongTimeout);
    keepAliveInterval = setInterval(sendPing, 8 * 60 * 1000);
}

client.connect();
console.log('Connecting...');

function promiseDelay(delay) {
    var deferred = Promise.pending();
    setTimeout(function () { deferred.resolve(); }, delay);
    return deferred.promise;
}

var commandTypes = keyHandler.getCommandTypes();
commandTypes.forEach(function (commandType) {
    startCommandListenLoop(commandType);
});

function startCommandListenLoop(type) {
    var lastAction = null;
    var startAction = keyHandler.getOptionsForType(type).startAction || null;
    function getAndExecuteCommand() {
        var data = keyHandler.getMostPopularAction(type);
        var options = keyHandler.getOptionsForType(type);
        var state = keyHandler.getState();
        if ((data !== null && data.action !== null) || (lastAction && (lastAction.continuous || state.repeatEnabled) && lastAction.canBeGlobalContinuous)) {
            var actionObj = data && data.action ? data.action : lastAction;
            console.log('executing', type, actionObj.desc);
            keyHandler.clearCommandQueue(type);
            var actionPromise = keyHandler.executeAction(actionObj, events);

            events.emit('command', {
                type: type,
                description: actionObj.desc,
                delay: Math.max(options.minDelay || 0, actionObj.delay())
            });
            lastAction = actionObj;

            Promise.all(options.minDelay ? [actionPromise, promiseDelay(options.minDelay)] : [actionPromise])
                .catch(function () {
                    console.log('Caught error while executing', type, actionObj);
                })
                .finally(getAndExecuteCommand);
        } else {
            var timeWait = 500; // if there is no command, still have a small guaranteed delay
            // tell those that are listening that there was no command to run
            events.emit('command', {
                type: type,
                idle: true,
                delay: timeWait
            });

            setTimeout(getAndExecuteCommand, timeWait);
        }
    }
    if (startAction) {
        keyHandler.executeAction(startAction, events)
            .finally(getAndExecuteCommand);
    } else {
        getAndExecuteCommand();
    }
}

console.log('Listening for commands...');

function pollWindowAlive() {
    var promise = isWindowAlive();
    promise.then(function (result) {
        if (!result || result[0] !== '0') {
            if (config.gameLaunchCommand) {
                console.log('Window not found, relaunching.');
                exec(config.gameLaunchCommand).then(function () {
                    setTimeout(pollWindowAlive, 5000);
                });
            } else {
                console.log('Window not found, no launch command specified, exiting...');
                stopEverything();
                process.exit(0);
            }
        } else {
            setTimeout(pollWindowAlive, 5000);
        }
    });
    promise.error(function () {
        console.log('Error: Error in windowalive script, closing stream and exiting.');
        stopEverything();
        process.exit(0);
    });
}
pollWindowAlive();
