declare module 'humanhash' {
    class HumanHasher {
        constructor(wordlist?: string[])
        humanize(hexdigest: string, words?: number, separator?: string): string
        uuid(words?: number, separator?: string, version?: number): { humanhash: string; uuid: string }
    }

    export = HumanHasher
}
