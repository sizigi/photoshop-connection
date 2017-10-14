"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const photoshop = require("./vendor/Photoshop");
var ImageType;
(function (ImageType) {
    ImageType[ImageType["JpegImage"] = 1] = "JpegImage";
    ImageType[ImageType["PixmapImage"] = 2] = "PixmapImage";
})(ImageType = exports.ImageType || (exports.ImageType = {}));
function createConnection(connectionOptions) {
    const options = Object.assign({ logger: console }, connectionOptions);
    const client = photoshop.createClient(options, undefined, options.logger);
    return new Promise((resolve, reject) => {
        client.once('connect', () => {
            options.logger.info(`Connected to Photoshop on port ${options.port}`);
            resolve(client);
        });
        client.on('error', (err) => {
            reject(err);
        });
    });
}
exports.createConnection = createConnection;
//# sourceMappingURL=index.js.map