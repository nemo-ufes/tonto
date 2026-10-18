import type { LangiumDocument, LangiumDocumentFactory, LangiumSharedCoreServices, WorkspaceFolder } from 'langium';
import { DefaultWorkspaceManager } from 'langium';
import { URI } from 'vscode-uri';
import { BUILTIN_DATATYPES_URI, builtinDatatypes } from './builtin-datatypes.js';
import { publicationWorkspace } from '../publication/workspace.js';

export class TontoWorkspaceManager extends DefaultWorkspaceManager {

    private readonly documentFactory: LangiumDocumentFactory;
    private readonly publication;

    constructor(services: LangiumSharedCoreServices) {
        super(services);
        this.documentFactory = services.workspace.LangiumDocumentFactory;
        this.publication = publicationWorkspace(services);
    }

    protected override async loadAdditionalDocuments(
        folders: WorkspaceFolder[],
        collector: (document: LangiumDocument) => void
    ): Promise<void> {
        this.publication.configure(folders.map(folder => URI.parse(folder.uri).fsPath));
        const document = this.documentFactory.fromString(builtinDatatypes, URI.parse(BUILTIN_DATATYPES_URI));
        collector(document);
    }
}
