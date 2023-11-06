import { UrlStorage } from "./url";
import { IpfsStorage } from "./ipfs";
import { ArweaveStorage } from "./arweave";


export class Storage {
    private files: []
    public constructor(files: []) {
        this.files = files
    }

    getStorageClass(type: string): any {
        switch (type) {
            case "url":
                return new UrlStorage(this.files);
            case "ipfs":
                return new IpfsStorage(this.files);
            case "arweave":
                return new ArweaveStorage(this.files);
            default:
                throw new Error(`Invalid storage type: ${type}`);
        }
    }
}