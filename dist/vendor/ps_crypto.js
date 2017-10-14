(function () {
    "use strict";
    var crypto = require("crypto");
    var SALT = "Adobe Photoshop", NUM_ITERATIONS = 1000, ALGORITHM = "des-ede3-cbc", KEY_LENGTH = 24, IV = new Buffer("000000005d260000", "hex"), DIGEST = 'sha1';
    function PSCrypto(derivedKey) {
        this._derivedKey = derivedKey;
    }
    PSCrypto.prototype.decipher = function (buf) {
        var d = crypto.createDecipheriv(ALGORITHM, this._derivedKey, IV);
        return new Buffer(d.update(buf, "binary", "binary") + d.final("binary"), "binary");
    };
    PSCrypto.prototype.cipher = function (buf) {
        var c = crypto.createCipheriv(ALGORITHM, this._derivedKey, IV);
        return new Buffer(c.update(buf, "binary", "binary") + c.final("binary"), "binary");
    };
    function createPSCrypto(password, callback) {
        crypto.pbkdf2(password, SALT, NUM_ITERATIONS, KEY_LENGTH, DIGEST, function (err, derivedKey) {
            if (err) {
                callback(err, null);
            }
            else {
                callback(null, new PSCrypto(derivedKey));
            }
        });
    }
    exports.createPSCrypto = createPSCrypto;
}());
//# sourceMappingURL=ps_crypto.js.map