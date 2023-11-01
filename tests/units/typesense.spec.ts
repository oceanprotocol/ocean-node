import 'jest';
import Typesense, {TypesenseCollections} from "../../src/components/database/typesense";
import {Logger} from "winston";
import {TypesenseConfigOptions} from "../../src/@types";
import {ddoSchema} from "../data/ddoSchema";

describe('Typesense', () => {
    let typesense: Typesense;

    beforeAll(() => {
        const config: TypesenseConfigOptions = {
            apiKey: 'xyz',
            nodes: [{
                host: 'localhost',
                port: 8108,
                protocol: 'http'
            }],
            logLevel: 'debug',
            logger: {
                debug: (log: any) => console.log(log),
            } as Logger
        };
        typesense = new Typesense(config);
    });

    it('instance Typesense', async () => {
        expect(typesense).toBeInstanceOf(Typesense);
    });

    it('instance TypesenseCollections', async () => {
        const result = typesense.collections();
        expect(result).toBeInstanceOf(TypesenseCollections);
    });

    it('create ddo collection', async () => {
        const result = await typesense.collections().create(ddoSchema);
        expect(result.enable_nested_fields).toBeTruthy();
        expect(result.fields).toBeDefined();
        expect(result.name).toEqual(ddoSchema.name);
        expect(result.num_documents).toEqual(0);
    });

    it('retrieve ddo collection', async () => {
        const result = await typesense.collections().retrieve();
        const collection = result[0];
        expect(collection.enable_nested_fields).toBeTruthy();
        expect(collection.fields).toBeDefined();
        expect(collection.name).toEqual(ddoSchema.name);
        expect(collection.num_documents).toEqual(0);
    });

    it('delete ddo collection', async () => {
        const result = await typesense.collections(ddoSchema.name).delete();
        expect(result.enable_nested_fields).toBeTruthy();
        expect(result.fields).toBeDefined();
        expect(result.name).toEqual(ddoSchema.name);
    });
});