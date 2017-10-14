import * as photoshop from './vendor/Photoshop';
import { EventEmitter } from 'events';

export enum ImageType {
  JpegImage = 1,
  PixmapImage = 2,
}

export type messageHandler = (messageID: number, messageBody: any, rawMessage: any) => void;
export type pixmapHandler= (messageID: number, messageBody: Buffer, rawMessage: any) => void;

export interface PhotoshopClient extends EventEmitter {
  isConnected(): boolean;
  disconnect(listener?: any): true | undefined;
  destroy(): void;
  sendKeepAlive(): number;
  sendImage(imageBuffer: any, imageType?: ImageType): number;
  sendCommand(extendScript: any): number;

  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: "message", listener: messageHandler): this;
  on(event: "pixmap", listener: pixmapHandler): this;

  once(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: "message", listener: messageHandler): this;
  once(event: "pixmap", listener: pixmapHandler): this;
}

export interface IConnectionOptions {
  password: string,
  hostname: string,
  port: number,
  logger?: any,
}

export function createConnection(connectionOptions: IConnectionOptions): Promise<PhotoshopClient> {
  const options = {
    logger: console,
    ...connectionOptions,
  }

  const client: PhotoshopClient = (photoshop.createClient(options, undefined, options.logger) as any) as PhotoshopClient;
  return new Promise((resolve, reject) => {
    client.once('connect', () => {
      options.logger.info(`Connected to Photoshop on port ${options.port}`)
      resolve(client);
    });
    client.on('error', (err: any) => {
      reject(err)
    });
  });

}
