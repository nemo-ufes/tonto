import { TontoRenameProvider } from './lsp/tonto-rename-provider.js';
import { TontoReferencesProvider } from './lsp/tonto-references-provider.js';
import type { DefaultSharedModuleContext, LangiumServices, LangiumSharedServices, PartialLangiumServices } from 'langium/lsp';
import { createDefaultModule, createDefaultSharedModule } from 'langium/lsp';
import type { Module } from 'langium';
import { inject } from 'langium';
import { TontoGeneratedModule, TontoGeneratedSharedModule } from './generated/module.js';
import { TontoDocumentationProvider } from './documentation/tonto-documentation-provider.js';
import { TontoCodeActionProvider } from './lsp/tonto-code-action-provider.js';
import { TontoCompletionProvider } from './lsp/tonto-completion-provider.js';
import { TontoFileOperationHandler } from './lsp/tonto-file-operation-handler.js';
import { TontoFoldingRangeProvider } from './lsp/tonto-folding-range-provider.js';
import { TontoFormatter } from './lsp/tonto-formatter.js';
import { TontoHoverProvider } from './lsp/tonto-hover-provider.js';
import { TontoSemanticTokenProvider } from './lsp/tonto-semantic-token-provider.js';
import { TontoScopeComputation } from './references/tonto-scope-computation.js';
import { resetDerivedCaches } from './utils/derived-cache.js';
import { TontoScopeProvider } from './references/tonto-scope-provider.js';
import { TontoDocumentBuilder } from './workspace/tonto-document-builder.js';
import { TontoParserErrorMessageProvider } from './parser/parser-error-messages.js';
import { TontoIndexManager } from './workspace/tonto-index-manager.js';
import { TontoWorkspaceManager } from './workspace/tonto-workspace-manager.js';
import { registerValidationChecks } from './tonto-validator.js';
import { PublicationDocumentValidator } from './publication/document-validator.js';
import { PublicationDefinitionProvider } from './publication/definition-provider.js';

export type TontoServices = LangiumServices;

/**
 * The language-specific dependency injection module. Everything not listed
 * here (parser, linker, definitions, references, rename, folding, document
 * symbols) comes from Langium's defaults, which the redesigned grammar's
 * explicit interfaces and clean field names are shaped to work well with.
 *
 */
export const TontoModule: Module<TontoServices, PartialLangiumServices> = {
    parser: {
        ParserErrorMessageProvider: () => new TontoParserErrorMessageProvider()
    },
    validation: {
        DocumentValidator: services => new PublicationDocumentValidator(services)
    },
    documentation: {
        DocumentationProvider: services => new TontoDocumentationProvider(services)
    },
    references: {
        ScopeComputation: services => new TontoScopeComputation(services),
        ScopeProvider: services => new TontoScopeProvider(services)
    },
    lsp: {
        DefinitionProvider: services => new PublicationDefinitionProvider(services),
        FoldingRangeProvider: services => new TontoFoldingRangeProvider(services),
        HoverProvider: services => new TontoHoverProvider(services),
        CompletionProvider: services => new TontoCompletionProvider(services),
        SemanticTokenProvider: services => new TontoSemanticTokenProvider(services),
        CodeActionProvider: services => new TontoCodeActionProvider(services),
        RenameProvider: services => new TontoRenameProvider(services),
        ReferencesProvider: services => new TontoReferencesProvider(services),
        Formatter: () => new TontoFormatter()
    }
};

export function createTontoServices(context: DefaultSharedModuleContext): {
    shared: LangiumSharedServices;
    Tonto: TontoServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        TontoGeneratedSharedModule,
        {
            workspace: {
                WorkspaceManager: (services: LangiumSharedServices) => new TontoWorkspaceManager(services),
                DocumentBuilder: (services: LangiumSharedServices) => new TontoDocumentBuilder(services),
                IndexManager: (services: LangiumSharedServices) => new TontoIndexManager(services)
            },
            lsp: {
                FileOperationHandler: (services: LangiumSharedServices) => new TontoFileOperationHandler(services)
            }
        }
    );
    const Tonto = inject(
        createDefaultModule({ shared }),
        TontoGeneratedModule,
        TontoModule
    );
    shared.ServiceRegistry.register(Tonto);
    registerValidationChecks(Tonto);
    // Caches of reference-derived information must not outlive a change to any
    // document: dependents are re-linked without being re-parsed, so their AST
    // nodes survive while what those nodes reference does not.
    shared.workspace.DocumentBuilder.onUpdate(() => resetDerivedCaches());
    return { shared, Tonto };
}
