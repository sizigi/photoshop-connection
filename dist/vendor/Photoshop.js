(function () {
    "use strict";
    var util = require("util"), EventEmitter = require("events").EventEmitter, net = require("net"), Q = require("q"), psCrypto = require("./ps_crypto");
    var DEFAULT_PASSWORD = "password", DEFAULT_PORT = 49494, DEFAULT_HOSTNAME = "127.0.0.1", SOCKET_KEEPALIVE_DELAY = 1000;
    var CONNECTION_STATES = {
        NONE: 0,
        CONNECTING: 1,
        OPEN: 2,
        CLOSING: 3,
        CLOSED: 4,
        DESTROYED: 5
    };
    var MESSAGE_LENGTH_OFFSET = 0, MESSAGE_STATUS_OFFSET = 4, MESSAGE_STATUS_LENGTH = 4, MESSAGE_PAYLOAD_OFFSET = MESSAGE_STATUS_OFFSET + MESSAGE_STATUS_LENGTH, PAYLOAD_HEADER_LENGTH = 12, PAYLOAD_PROTOCOL_OFFSET = 0, PAYLOAD_ID_OFFSET = 4, PAYLOAD_TYPE_OFFSET = 8, MAX_MESSAGE_ID = 256 * 256 * 256, PROTOCOL_VERSION = 1, MESSAGE_TYPE_ERROR = 1, MESSAGE_TYPE_JAVASCRIPT = 2, MESSAGE_TYPE_PIXMAP = 3, MESSAGE_TYPE_ICC_PROFILE = 4, MESSAGE_TYPE_KEEPALIVE = 6, STATUS_NO_COMM_ERROR = 0;
    var INITIAL_MESSAGE_BUFFER_SIZE = 65536, KNOWN_LITERAL_STRING_MESSAGES = ["", "[ActionDescriptor]", "Yep, still alive"];
    function ensureBufferSize(buffer, minimumSize, contentSize) {
        if (buffer.length >= minimumSize) {
            return buffer;
        }
        var newBuffer = new Buffer(minimumSize);
        if (contentSize) {
            buffer.copy(newBuffer, 0, 0, contentSize);
        }
        else {
            buffer.copy(newBuffer);
        }
        return newBuffer;
    }
    function round(value, decimals) {
        var factor = Math.pow(10, decimals);
        return Math.round(factor * value) / factor;
    }
    function PhotoshopClient(options, connectListener, logger) {
        var self = this;
        if (!(self instanceof PhotoshopClient)) {
            return new PhotoshopClient(options, connectListener, logger);
        }
        else {
            var password = DEFAULT_PASSWORD;
            if (options.hasOwnProperty("password")) {
                password = options.password;
            }
            if (options.hasOwnProperty("port")) {
                self._port = options.port;
            }
            if (options.hasOwnProperty("hostname")) {
                self._hostname = options.hostname;
            }
            if (options.hasOwnProperty("inputFd")) {
                self._inputFd = options.inputFd;
            }
            if (options.hasOwnProperty("outputFd")) {
                self._outputFd = options.outputFd;
            }
            self._logger = logger;
            self._receiveBuffer = new Buffer(INITIAL_MESSAGE_BUFFER_SIZE);
            self._receivedBytes = 0;
            self._writeQueue = [];
            if (connectListener) {
                this.once("connect", connectListener);
            }
            var connectionPromise = null;
            var cryptoPromise = null;
            if ((typeof self._inputFd === "number" && typeof self._outputFd === "number") ||
                (typeof self._inputFd === "string" && typeof self._outputFd === "string")) {
                connectionPromise = self._connectPipe();
                var cryptoDeferred = Q.defer();
                cryptoDeferred.resolve();
                cryptoPromise = cryptoDeferred.promise;
            }
            else if (self._hostname && typeof self._port === "number") {
                connectionPromise = self._connectSocket();
                cryptoPromise = self._initCrypto(password);
            }
            else {
                var connectionDeferred = Q.defer();
                connectionDeferred.reject();
                connectionPromise = connectionDeferred.promise;
            }
            Q.all([
                connectionPromise,
                cryptoPromise
            ]).done(function () {
                self.emit("connect");
            }, function (err) {
                self.emit("error", err);
                self.disconnect();
            });
        }
    }
    util.inherits(PhotoshopClient, EventEmitter);
    PhotoshopClient.prototype._port = DEFAULT_PORT;
    PhotoshopClient.prototype._hostname = DEFAULT_HOSTNAME;
    PhotoshopClient.prototype._connectionState = CONNECTION_STATES.NONE;
    PhotoshopClient.prototype._lastMessageID = 0;
    PhotoshopClient.prototype._crypto = null;
    PhotoshopClient.prototype._receiveBuffer = null;
    PhotoshopClient.prototype._receivedBytes = 0;
    PhotoshopClient.prototype._writeQueue = null;
    PhotoshopClient.prototype._commandDeferreds = null;
    PhotoshopClient.prototype._initCrypto = function (password) {
        var self = this;
        var cryptoDeferred = Q.defer();
        psCrypto.createPSCrypto(password, function (err, crypto) {
            if (err) {
                cryptoDeferred.reject(err);
            }
            else {
                self._crypto = crypto;
                cryptoDeferred.resolve();
            }
        });
        return cryptoDeferred.promise;
    };
    PhotoshopClient.prototype._connectPipe = function () {
        var self = this;
        var fs = require("fs");
        var result = false;
        try {
            self._connectionState = CONNECTION_STATES.CONNECTING;
            if (typeof self._inputFd === "number") {
                self._readStream = fs.createReadStream(null, { fd: self._inputFd });
            }
            else {
                self.emit("info", "using named read pipe " + self._inputFd);
                self._readStream = fs.createReadStream(self._inputFd);
            }
            self._readStream.on("data", function (incomingBuffer) {
                var isNewMessage = self._receivedBytes === 0, minimumSize = incomingBuffer.length + self._receivedBytes;
                self._receiveBuffer = ensureBufferSize(self._receiveBuffer, minimumSize);
                incomingBuffer.copy(self._receiveBuffer, self._receivedBytes);
                self._receivedBytes += incomingBuffer.length;
                self._processReceiveBuffer(isNewMessage);
            });
            self._readStream.on("error", function (err) {
                self.emit("error", "Pipe read error: " + err);
                self.disconnect();
            });
            self._readStream.on("close", function () {
                self._connectionState = CONNECTION_STATES.CLOSED;
                self.emit("close");
            });
            self._readStream.resume();
            if (typeof self._outputFd === "number") {
                self._writeStream = fs.createWriteStream(null, { fd: self._outputFd });
            }
            else {
                self.emit("info", "using named write pipe " + self._outputFd);
                self._writeStream = fs.createWriteStream(self._outputFd);
            }
            self._writeStream.on("error", function (err) {
                self.emit("error", "Pipe write error: " + err);
                self.disconnect();
            });
            self._writeStream.on("close", function () {
                self._connectionState = CONNECTION_STATES.CLOSED;
                self.emit("close");
            });
            self._writeStream.on("drain", function () {
                self._doPendingWrites();
            });
            result = true;
        }
        catch (e) {
            self.emit("error", "Connect Pipe error: " + e);
            self.disconnect();
        }
        return result;
    };
    PhotoshopClient.prototype._connectSocket = function () {
        var self = this;
        var connectSocketDeferred = Q.defer();
        self._socket = new net.Socket();
        self._connectionState = CONNECTION_STATES.CONNECTING;
        self._socket.connect(self._port, self._hostname);
        self._socket.on("connect", function () {
            self._socket.setKeepAlive(true, SOCKET_KEEPALIVE_DELAY);
            self._socket.setNoDelay();
            connectSocketDeferred.resolve(self);
            self._writeStream = self._socket;
        });
        self._socket.on("error", function (err) {
            if (connectSocketDeferred.promise.isPending()) {
                connectSocketDeferred.reject(err);
            }
            self.emit("error", "Socket error: " + err);
            self.disconnect();
        });
        self._socket.on("close", function () {
            self._connectionState = CONNECTION_STATES.CLOSED;
            self.emit("close");
        });
        self._socket.on("data", function (incomingBuffer) {
            var isNewMessage = self._receivedBytes === 0, minimumSize = incomingBuffer.length + self._receivedBytes;
            self._receiveBuffer = ensureBufferSize(self._receiveBuffer, minimumSize);
            incomingBuffer.copy(self._receiveBuffer, self._receivedBytes);
            self._receivedBytes += incomingBuffer.length;
            self._processReceiveBuffer(isNewMessage);
        });
        self._socket.on("drain", function () {
            self._doPendingWrites();
        });
        return connectSocketDeferred.promise;
    };
    PhotoshopClient.prototype._writeWhenFree = function (buffer) {
        var self = this;
        self._writeQueue.push(buffer);
        process.nextTick(function () { self._doPendingWrites(); });
    };
    PhotoshopClient.prototype._doPendingWrites = function () {
        if (this._writeStream && this._writeQueue.length > 0 && !this._writeStream.busy) {
            var bufferToWrite = this._writeQueue.shift();
            var writeStatus = this._writeStream.write(bufferToWrite);
            if (writeStatus && this._writeQueue.length > 0) {
                this._doPendingWrites();
            }
        }
        if (this._writeStream && this._writeQueue.length > 0) {
            process.nextTick(this._doPendingWrites.bind(this));
        }
    };
    PhotoshopClient.prototype.isConnected = function () {
        return (this._connectionState === CONNECTION_STATES.OPEN);
    };
    PhotoshopClient.prototype.disconnect = function (listener) {
        if (!listener) {
            listener = function () { };
        }
        if (this._socket) {
            var currentState = this._connectionState;
            switch (currentState) {
                case CONNECTION_STATES.NONE:
                    this._connectionState = CONNECTION_STATES.CLOSED;
                    process.nextTick(listener);
                    return true;
                case CONNECTION_STATES.CONNECTING:
                    this._connectionState = CONNECTION_STATES.CLOSING;
                    this._socket.once("close", listener);
                    this._socket.end();
                    return true;
                case CONNECTION_STATES.OPEN:
                    this._connectionState = CONNECTION_STATES.CLOSING;
                    this._socket.once("close", listener);
                    this._socket.end();
                    return true;
                case CONNECTION_STATES.CLOSING:
                    this._socket.once("close", listener);
                    return true;
                case CONNECTION_STATES.CLOSED:
                    process.nextTick(listener);
                    return true;
                case CONNECTION_STATES.DESTROYED:
                    process.nextTick(listener);
                    return true;
            }
        }
        else {
            if (this._readStream) {
                try {
                    this._readStream.close();
                }
                catch (readCloseError) {
                }
                this._readStream = null;
            }
            if (this._writeStream) {
                try {
                    this._writeStream.close();
                }
                catch (writeCloseError) {
                }
                this._writeStream = null;
            }
            this._connectionState = CONNECTION_STATES.CLOSED;
            process.nextTick(listener);
            return true;
        }
    };
    PhotoshopClient.prototype.destroy = function () {
        this._connectionState = CONNECTION_STATES.DESTROYED;
        if (this._socket) {
            this._socket.destroy();
        }
    };
    PhotoshopClient.prototype._sendMessage = function (payloadBuffer) {
        var cipheredPayloadBuffer = this._crypto ? this._crypto.cipher(payloadBuffer) : payloadBuffer;
        var headerBuffer = new Buffer(MESSAGE_PAYLOAD_OFFSET);
        var messageLength = cipheredPayloadBuffer.length + MESSAGE_STATUS_LENGTH;
        headerBuffer.writeUInt32BE(messageLength, MESSAGE_LENGTH_OFFSET);
        headerBuffer.writeInt32BE(STATUS_NO_COMM_ERROR, MESSAGE_STATUS_OFFSET);
        this._writeWhenFree(headerBuffer);
        this._writeWhenFree(cipheredPayloadBuffer);
    };
    PhotoshopClient.prototype.sendKeepAlive = function () {
        var id = this._lastMessageID = (this._lastMessageID + 1) % MAX_MESSAGE_ID, payloadBuffer = new Buffer(PAYLOAD_HEADER_LENGTH);
        payloadBuffer.writeUInt32BE(PROTOCOL_VERSION, PAYLOAD_PROTOCOL_OFFSET);
        payloadBuffer.writeUInt32BE(id, PAYLOAD_ID_OFFSET);
        payloadBuffer.writeUInt32BE(MESSAGE_TYPE_KEEPALIVE, PAYLOAD_TYPE_OFFSET);
        this._sendMessage(payloadBuffer);
        return id;
    };
    PhotoshopClient.prototype.sendImage = function (imageBuffer, imageType = 1) {
        const id = this._lastMessageID = (this._lastMessageID + 1) % MAX_MESSAGE_ID;
        const payloadBuffer = new Buffer(PAYLOAD_HEADER_LENGTH + imageBuffer.length + 1);
        payloadBuffer.writeUInt32BE(PROTOCOL_VERSION, PAYLOAD_PROTOCOL_OFFSET);
        payloadBuffer.writeUInt32BE(id, PAYLOAD_ID_OFFSET);
        payloadBuffer.writeUInt32BE(MESSAGE_TYPE_PIXMAP, PAYLOAD_TYPE_OFFSET);
        payloadBuffer.writeInt8(imageType, PAYLOAD_HEADER_LENGTH);
        imageBuffer.copy(payloadBuffer, PAYLOAD_HEADER_LENGTH + 1);
        this._sendMessage(payloadBuffer);
        return id;
    };
    PhotoshopClient.prototype.sendCommand = function (javascript) {
        var id = this._lastMessageID = (this._lastMessageID + 1) % MAX_MESSAGE_ID, codeBuffer = new Buffer(javascript, "utf8"), payloadBuffer = new Buffer(codeBuffer.length + PAYLOAD_HEADER_LENGTH);
        payloadBuffer.writeUInt32BE(PROTOCOL_VERSION, PAYLOAD_PROTOCOL_OFFSET);
        payloadBuffer.writeUInt32BE(id, PAYLOAD_ID_OFFSET);
        payloadBuffer.writeUInt32BE(MESSAGE_TYPE_JAVASCRIPT, PAYLOAD_TYPE_OFFSET);
        codeBuffer.copy(payloadBuffer, PAYLOAD_HEADER_LENGTH);
        this._sendMessage(payloadBuffer);
        return id;
    };
    PhotoshopClient.prototype._processReceiveBuffer = function (isNewMessage) {
        if (isNewMessage && this._receivedBytes > 0) {
            this.messageStartTime = new Date().getTime();
        }
        if (this._receivedBytes < MESSAGE_PAYLOAD_OFFSET) {
            return;
        }
        var commStatus = this._receiveBuffer.readInt32BE(MESSAGE_STATUS_OFFSET);
        if (commStatus !== STATUS_NO_COMM_ERROR) {
            console.error("Communication error: " + commStatus);
            this.emit("communicationsError", "Photoshop communication error: " + commStatus);
            this.disconnect();
            return;
        }
        var messageLength = this._receiveBuffer.readUInt32BE(MESSAGE_LENGTH_OFFSET), totalLength = messageLength + MESSAGE_STATUS_OFFSET;
        this._receiveBuffer = ensureBufferSize(this._receiveBuffer, totalLength, this._receivedBytes);
        if (this._receivedBytes < totalLength) {
            return;
        }
        var duration = new Date().getTime() - this.messageStartTime;
        if (duration > 10) {
            var size = this._receivedBytes / 1024, speed = size / (duration / 1000);
            this._logger.info(duration + "ms to receive " + round(size, 1) + " kB (" + round(speed, 1) + " kB/s)");
        }
        var cipheredBody = this._receiveBuffer.slice(MESSAGE_PAYLOAD_OFFSET, totalLength), remainingBytes = this._receivedBytes - totalLength, preferredBufferSize = Math.max(INITIAL_MESSAGE_BUFFER_SIZE, remainingBytes);
        var oldBuffer = this._receiveBuffer;
        this._receiveBuffer = new Buffer(preferredBufferSize);
        if (remainingBytes > 0) {
            oldBuffer.copy(this._receiveBuffer, 0, totalLength, this._receivedBytes);
        }
        this._receivedBytes = remainingBytes;
        var startTime = new Date().getTime(), bodyBuffer = this._crypto ? this._crypto.decipher(cipheredBody) : cipheredBody;
        duration = new Date().getTime() - startTime;
        if (duration > 10) {
            this._logger.info(duration + "ms to decrypt buffer");
        }
        this._processMessage(bodyBuffer);
        this._processReceiveBuffer(true);
    };
    PhotoshopClient.prototype._processMessage = function (bodyBuffer) {
        var protocolVersion = bodyBuffer.readUInt32BE(PAYLOAD_PROTOCOL_OFFSET), messageID = bodyBuffer.readUInt32BE(PAYLOAD_ID_OFFSET), messageType = bodyBuffer.readUInt32BE(PAYLOAD_TYPE_OFFSET), messageBody = bodyBuffer.slice(PAYLOAD_HEADER_LENGTH);
        var rawMessage = {
            protocolVersion: protocolVersion,
            id: messageID,
            type: messageType,
            body: messageBody
        };
        if (protocolVersion !== PROTOCOL_VERSION) {
            this.emit("communicationsError", "unknown protocol version", protocolVersion);
        }
        else if (messageType === MESSAGE_TYPE_JAVASCRIPT) {
            var messageBodyString = messageBody.toString("utf8");
            var messageBodyParts = messageBodyString.split("\r");
            var eventName = null;
            var parsedValue = null;
            if (messageBodyParts.length === 2) {
                eventName = messageBodyParts[0];
            }
            parsedValue = messageBodyParts[messageBodyParts.length - 1];
            if (KNOWN_LITERAL_STRING_MESSAGES.indexOf(parsedValue) === -1) {
                try {
                    parsedValue = JSON.parse(parsedValue);
                }
                catch (jsonParseException) {
                }
            }
            if (eventName) {
                this.emit("event", messageID, eventName, parsedValue, rawMessage);
            }
            else {
                this.emit("message", messageID, parsedValue, rawMessage);
            }
        }
        else if (messageType === MESSAGE_TYPE_PIXMAP) {
            this.emit("pixmap", messageID, messageBody, rawMessage);
        }
        else if (messageType === MESSAGE_TYPE_ICC_PROFILE) {
            this.emit("iccProfile", messageID, messageBody, rawMessage);
        }
        else if (messageType === MESSAGE_TYPE_ERROR) {
            this.emit("error", { id: messageID, body: messageBody.toString("utf8") });
        }
        else {
            this.emit("communicationsError", "unknown message type", messageType);
        }
    };
    function createClient(options, connectListener, logger) {
        return new PhotoshopClient(options, connectListener, logger);
    }
    exports.PhotoshopClient = PhotoshopClient;
    exports.createClient = createClient;
}());
//# sourceMappingURL=Photoshop.js.map