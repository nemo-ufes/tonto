import type { LangiumSharedCoreServices, ValidationAcceptor } from 'langium';

/** The VS Code section and key: `tonto.antiPatterns`. */
const SECTION = 'tonto';
const KEY = 'antiPatterns';

/**
 * Whether the anti-pattern checks say anything, which by default they do not.
 *
 * The anti-patterns (Sales & Guizzardi 2015) are not errors: they describe
 * structures that parse, validate, and are merely *often* a mistake. On a real
 * model they fire constantly -- every relation between two roles of one kind
 * is a `BinOver`, and most models are full of them -- and a diagnostic that is
 * usually noise trains its reader to ignore the ones that are not. They are
 * worth having on demand, so they are off until asked for.
 *
 * Turning the setting on or off re-validates every open document. That goes
 * through `DocumentBuilder.update`, which is the only thing that clears the
 * per-document build state: a plain `build` remembers which validation
 * categories already ran, finds none outstanding, and appends nothing to
 * diagnostics that are now stale.
 */
export class AntiPatternSetting {

    private on = false;

    constructor(private readonly shared: LangiumSharedCoreServices) {
        const configuration = shared.workspace.ConfigurationProvider;
        void configuration.getConfiguration(SECTION, KEY).then(value => this.apply(value));
        configuration.onConfigurationSectionUpdate(update => {
            if (update.section === SECTION) {
                void this.apply((update.configuration as Record<string, unknown> | undefined)?.[KEY]);
            }
        });
    }

    get enabled(): boolean {
        return this.on;
    }

    /**
     * Runs a check only while the setting is on, keeping the decision in one
     * place rather than at the head of six checks.
     */
    gate<T>(check: (node: T, accept: ValidationAcceptor) => void): (node: T, accept: ValidationAcceptor) => void {
        return (node, accept) => {
            if (this.on) {
                check(node, accept);
            }
        };
    }

    private async apply(value: unknown): Promise<void> {
        const next = value === true;
        if (next === this.on) {
            return;
        }
        this.on = next;
        // Only what a file or an open editor can supply again. The built-in
        // datatype library is a string at `tonto:///builtin/...` with nothing
        // behind it, and asking to re-read it throws ENOENT.
        const uris = this.shared.workspace.LangiumDocuments.all
            .filter(document => document.uri.scheme === 'file')
            .map(document => document.uri)
            .toArray();
        await this.shared.workspace.DocumentBuilder.update(uris, []);
    }
}
