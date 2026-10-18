import { AstUtils, DefaultDocumentBuilder, DocumentState, URI } from 'langium';
import type {
    AstNode, BuildOptions, LangiumDocument, LangiumSharedCoreServices, MultiReference, Reference
} from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import { isGeneralizationSet } from '../generated/ast.js';
import type { Ontology, Package } from '../generated/ast.js';
import { declaredNamespace } from '../utils/namespaces.js';
import { bindGeneralizationSetLookup } from '../utils/generalizations.js';
import { createReverseLookup } from '../validation/incoming-relations.js';
import { publicationWorkspace, ownerOf } from '../publication/workspace.js';

/**
 * Rebuilds the documents a change can be *seen from*, not only the ones that
 * can see the change.
 *
 * Langium relinks a document when something it references changed -- which is
 * the right direction for scoping, and the wrong one for half the checks here.
 * Several rules read what points *at* a class rather than what it declares: a
 * relator has to mediate two things, a moment has to have a bearer, a role has
 * to have a relator, a power type has to have a base. The relation carrying
 * that evidence is usually written in the file that needs it, not in the file
 * declaring the type, so the diagnostic sits in A while the evidence sits in
 * B, and editing B left A saying what it said before -- for as long as A went
 * untouched, which could be for ever.
 *
 * So the affected set gains the documents the changed ones *point at*, taken
 * both before the change and after it: before, because a mediation that has
 * just been deleted is evidence that has just stopped existing, and after,
 * because one that has just been written is evidence that has just appeared.
 * Only validation is re-run for them -- their own parse, scope and links are
 * untouched by a change elsewhere.
 */
export class TontoDocumentBuilder extends DefaultDocumentBuilder {

    private readonly publication;

    constructor(services: LangiumSharedCoreServices) {
        super(services);
        this.publication = publicationWorkspace(services);
    }

    /**
     * Every document gets this workspace's lookup before anything reads it.
     *
     * Ancestry and disjointness both need the generalization sets that name a
     * class from *another* document, and neither has services to ask. The
     * lookup was a module-level variable once, which meant the last
     * `TontoSession` created owned it and every earlier one silently stopped
     * seeing cross-document generalizations. It is stamped here rather than
     * during validation because the class being asked about is usually in a
     * document other than the one being validated -- often one that has been
     * parsed and never validated at all.
     */
    protected override async buildDocuments(
        documents: LangiumDocument[], options: BuildOptions, cancelToken: CancellationToken
    ): Promise<void> {
        // Here rather than in `build`, which is only one of the two ways in:
        // `update` reaches the phases without passing through it, so a
        // document changed on disk went unstamped and the checks that read
        // another document's sets fell back to the local ones.
        for (const document of documents) {
            if (document.state < DocumentState.Parsed) await this.langiumDocumentFactory.update(document, cancelToken);
        }
        // Ownership decides what every package can see, and it has no
        // reference edge: the first entry, or a changed namespace annotation,
        // changes how documents that did not change link.
        // Relink everything then, and only then -- an edit inside an ontology
        // leaves ownership as it was, and the peers whose identifiers it can
        // clash with are revalidated by `update`.
        const before = this.ownership;
        const complete = this.publication.prepare();
        this.ownership = this.publication.signature();
        if (before !== this.ownership) {
            for (const document of complete) {
                if (document.state > DocumentState.Parsed) this.resetToState(document, DocumentState.Parsed);
            }
            documents = complete;
            this.relinkedAll = true;
        } else {
            // Dependencies loaded just now are new to the build.
            const building = new Set(documents);
            documents = [...documents, ...complete.filter(document => !building.has(document) && document.state < DocumentState.Validated)];
        }
        this.reverse?.reset();
        for (const document of documents) {
            bindGeneralizationSetLookup(document, node => this.lookup().referrers(node).filter(isGeneralizationSet));
        }
        return super.buildDocuments(documents, options, cancelToken);
    }

    private reverse?: ReturnType<typeof createReverseLookup>;
    private ownership?: string;
    /** Whether the last build relinked and revalidated every document. */
    private relinkedAll = false;

    /** Built once per builder: the index and the documents are its own. */
    private lookup(): ReturnType<typeof createReverseLookup> {
        if (!this.reverse) {
            this.reverse = createReverseLookup(
                this.indexManager,
                this.langiumDocuments,
                this.serviceRegistry.all[0].workspace.AstNodeLocator);
            // Its own listener, so what it remembers is forgotten with this
            // builder rather than living in a module-level registry that
            // nothing ever removes from.
            const forget = this.reverse;
            this.onUpdate(() => forget.reset());
        }
        return this.reverse;
    }

    override async update(changed: URI[], deleted: URI[], cancelToken?: CancellationToken): Promise<void> {
        // What the changed documents pointed at while they still said what
        // they used to say. After `super.update` their references are the new
        // ones, and a deleted document has no references at all.
        const before = this.closureOver([...changed, ...deleted]);
        this.relinkedAll = false;
        await super.update(changed, deleted, cancelToken);
        if (this.relinkedAll) {
            // Every document was just validated against the new ownership.
            return;
        }
        const after = this.closureOver(changed);

        const untouched = new Set([...changed, ...deleted].map(uri => uri.toString()));
        const stale = [...new Map([...before, ...after].map(document => [document.uri.toString(), document]))]
            .filter(([uri, document]) => !untouched.has(uri) && document.state === DocumentState.Validated)
            .map(([, document]) => document);
        if (stale.length === 0) {
            return;
        }
        // Back to the last phase before validation, so the rebuild re-runs the
        // checks and nothing else.
        for (const document of stale) {
            this.resetToState(document, DocumentState.IndexedReferences);
        }
        await this.build(stale, { validation: true }, cancelToken);
    }

    /**
     * Every document a change can reach, following the dependency until it
     * stops.
     *
     * One hop is not enough, because the evidence these checks read chains.
     * A relator in one file mediates a role in a second; a sub-role of that
     * role, in a third, is a role with a relator because of it. Removing the
     * mediation reaches the second file and used to stop there, leaving the
     * third saying what it said before -- for as long as nobody touched it,
     * which could be for ever. The same for a generalization set a level
     * above a subtype's subtype.
     *
     * So it runs to a fixed point, in both directions: what these documents
     * point at, what points at them, and what reads the generalization sets
     * they declare. In a model whose files all reach one core package that is
     * most of the workspace, which is the honest cost of checks that are
     * about the model rather than the file. Only validation re-runs for them.
     */
    private closureOver(uris: URI[]): LangiumDocument[] {
        const found = new Map<string, LangiumDocument>();
        let frontier = uris
            .map(uri => this.langiumDocuments.getDocument(uri))
            .filter((document): document is LangiumDocument => !!document);
        // Names, not references: two documents declaring one package are a
        // conflict, and nothing points from either to the other. So are two
        // whose packages publish into one namespace and declare one name.
        for (const document of [...this.documentsSharingPackageNames(frontier), ...this.documentsSharingNamespaces(frontier)]) {
            found.set(document.uri.toString(), document);
        }
        // Built once for the whole walk. Asking each round which documents
        // point at the frontier meant a pass over every reference in the
        // workspace per round, and a chain of files is as many rounds as it
        // is long.
        const pointedBy = this.incomingReferences();
        while (frontier.length > 0) {
            const next: LangiumDocument[] = [];
            const reached = [
                ...this.documentsReading(frontier),
                ...frontier.flatMap(document => pointedBy.get(document.uri.toString()) ?? [])
            ];
            for (const document of reached) {
                const key = document.uri.toString();
                if (!found.has(key)) {
                    found.set(key, document);
                    next.push(document);
                }
            }
            frontier = next;
        }
        return [...found.values()];
    }

    /** Documents declaring a package that one of these declares. */
    private documentsSharingPackageNames(documents: LangiumDocument[]): LangiumDocument[] {
        const names = new Set(documents.flatMap(document => packageNamesOf(document)));
        if (names.size === 0) {
            return [];
        }
        return this.langiumDocuments.all
            .filter(document => packageNamesOf(document).some(name => names.has(name)))
            .toArray();
    }

    /** Documents whose ontology declares a `@namespace` one of these declares too. */
    private documentsSharingNamespaces(documents: LangiumDocument[]): LangiumDocument[] {
        const namespaces = new Set(documents.flatMap(document => namespacesOf(document)));
        const ownership = new Set(documents.flatMap(document => (document.parseResult.value as { packages?: Package[] }).packages ?? []).map(ownerOf));
        return this.langiumDocuments.all
            .filter(document => namespacesOf(document).some(namespace => namespaces.has(namespace))
                || ((document.parseResult.value as { packages?: Package[] }).packages ?? []).some(pkg => ownership.has(ownerOf(pkg))))
            .toArray();
    }

    /** For each document, the documents whose references resolve into it. */
    private incomingReferences(): Map<string, LangiumDocument[]> {
        const pointedBy = new Map<string, LangiumDocument[]>();
        for (const source of this.langiumDocuments.all) {
            const targets = new Set<string>();
            for (const reference of source.references ?? []) {
                for (const node of resolved(reference)) {
                    targets.add(AstUtils.getDocument(node).uri.toString());
                }
            }
            for (const target of targets) {
                (pointedBy.get(target) ?? pointedBy.set(target, []).get(target) as LangiumDocument[]).push(source);
            }
        }
        return pointedBy;
    }

    /**
     * Every document whose answers these documents can change.
     *
     * Two ways that happens. A document points at a class, and the checks that
     * read what points *at* a class then answer differently -- that is
     * `documentsPointedAtBy`. And a document holds a generalization set, whose
     * specifics gain an edge and a disjointness that any document naming them
     * reads: a set in a third file is what the two documents on either side of
     * it have in common, and neither references the other.
     */
    private documentsReading(documents: LangiumDocument[]): LangiumDocument[] {
        const uris = documents.map(document => document.uri);
        const found = new Map<string, LangiumDocument>();
        for (const document of [...this.documentsPointedAtBy(uris), ...this.documentsReadingSetsIn(uris)]) {
            found.set(document.uri.toString(), document);
        }
        return [...found.values()];
    }

    /** Documents that name a specific of a generalization set declared here. */
    private documentsReadingSetsIn(uris: URI[]): LangiumDocument[] {
        const found = new Map<string, LangiumDocument>();
        for (const uri of uris) {
            const source = this.langiumDocuments.getDocument(uri);
            if (!source) {
                continue;
            }
            for (const node of AstUtils.streamAllContents(source.parseResult.value)) {
                if (!isGeneralizationSet(node)) {
                    continue;
                }
                for (const specific of node.specifics) {
                    for (const referrer of specific.ref ? this.lookup().referrers(specific.ref) : []) {
                        const document = AstUtils.getDocument(referrer);
                        found.set(document.uri.toString(), document);
                    }
                }
            }
        }
        return [...found.values()];
    }

    /** The loaded documents these documents' resolved references reach into. */
    private documentsPointedAtBy(uris: URI[]): LangiumDocument[] {
        const found = new Map<string, LangiumDocument>();
        for (const uri of uris) {
            const source = this.langiumDocuments.getDocument(uri);
            for (const reference of source?.references ?? []) {
                for (const node of resolved(reference)) {
                    const target = AstUtils.getDocument(node);
                    if (target.uri.toString() !== uri.toString()) {
                        found.set(target.uri.toString(), target);
                    }
                }
            }
        }
        return [...found.values()];
    }
}

/** The packages a document declares, which is what a name clash is between. */
function packageNamesOf(document: LangiumDocument): string[] {
    const model = document.parseResult?.value as { packages?: Array<{ name?: string }> } | undefined;
    return (model?.packages ?? []).map(pkg => pkg.name).filter((name): name is string => !!name);
}

function namespacesOf(document: LangiumDocument): string[] {
    const model = document.parseResult?.value as { ontologies?: Ontology[] } | undefined;
    return (model?.ontologies ?? []).map(declaredNamespace).filter((namespace): namespace is string => !!namespace);
}

/** What a reference resolved to, whether it names one target or several. */
function resolved(reference: Reference | MultiReference): AstNode[] {
    if ('items' in reference) {
        return reference.items.map(item => item.ref).filter((node): node is AstNode => !!node);
    }
    return reference.ref ? [reference.ref] : [];
}
