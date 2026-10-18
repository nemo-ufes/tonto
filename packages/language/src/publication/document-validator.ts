import { AstUtils, DefaultDocumentValidator } from 'langium';
import type { AstNode, DiagnosticInfo, ValidationSeverity, LangiumCoreServices, LangiumDocument, ValidationOptions } from 'langium';
import type { Diagnostic } from 'vscode-languageserver';
import { dirname, relative, sep } from 'node:path';
import { isImport, isPackage } from '../generated/ast.js';
import type { Import, Model } from '../generated/ast.js';
import { importCandidates } from './import-assist.js';
import { applicableImports, ownerOf, publicationWorkspace } from './workspace.js';

export class PublicationDocumentValidator extends DefaultDocumentValidator {
    constructor(private readonly services: LangiumCoreServices) { super(services); }

    protected override toDiagnostic<N extends AstNode>(severity: ValidationSeverity, message: string, info: DiagnosticInfo<N, string>): Diagnostic {
        const diagnostic = super.toDiagnostic(severity, message, info);
        const unit = ownerOf(info.node);
        if (unit) diagnostic.data = { ...diagnostic.data as object, ontology: unit.id };
        if (diagnostic.code === 'package-name-case' && (publicationWorkspace(this.services.shared).isPublication
            || AstUtils.getDocument(info.node).uri.scheme.startsWith('http'))) diagnostic.severity = 1;
        return diagnostic;
    }

    protected override processLinkingErrors(document: LangiumDocument, diagnostics: Diagnostic[], options: ValidationOptions): void {
        const start = diagnostics.length;
        super.processLinkingErrors(document, diagnostics, options);
        const publication = publicationWorkspace(this.services.shared);
        for (const diagnostic of diagnostics.slice(start)) {
            const reference = document.references.find(ref => ref.$refNode?.range.start.line === diagnostic.range.start.line
                && ref.$refNode.range.start.character === diagnostic.range.start.character);
            // The import that did not load already says so; every reference
            // through its alias failing as well is the same problem again.
            const container = reference?.$refNode?.astNode;
            const pkg = container && AstUtils.getContainerOfType(container, isPackage);
            const model = document.parseResult.value as Model;
            if (reference && (pkg ? applicableImports(pkg) : model.imports).some(imp => imp.alias && publication.failed(imp)
                && reference.$refText.startsWith(`${imp.alias}.`))) {
                diagnostics.splice(diagnostics.indexOf(diagnostic), 1);
                continue;
            }
            const foreign = reference && isImport(container) && container.package === reference
                ? this.foreignPackage(document, container, reference.$refText) : undefined;
            if (foreign) {
                diagnostic.code = 'cross-ontology-package-use';
                diagnostic.message = foreign;
                diagnostic.data = { ...diagnostic.data as object, code: 'cross-ontology-package-use' };
                continue;
            }
            const info = reference?.error?.info;
            const candidates = info ? importCandidates(this.services, info, reference!.$refText) : [];
            if (candidates.length) {
                diagnostic.code = 'missing-package-use';
                diagnostic.message = `"${reference!.$refText}" belongs to package "${candidates[0].pkg.name}", which this package does not use. Add "use ${candidates[0].pkg.name}".`;
                diagnostic.data = { ...diagnostic.data as object, code: 'missing-package-use' };
            }
        }
    }

    /**
     * A `use` names a package of this ontology. When the name is one
     * of another ontology's packages instead, "could not resolve" -- and an
     * offer to create a class of that name -- hides what is wrong: ownership,
     * not spelling, keeps the import from binding.
     */
    private foreignPackage(document: LangiumDocument, imp: Import, name: string): string | undefined {
        const own = ownerOf(imp) ?? (document.parseResult.value as Model).packages.map(ownerOf).find(unit => !!unit);
        const owner = publicationWorkspace(this.services.shared).units
            .find(unit => unit !== own && unit.packages.some(pkg => pkg.name === name));
        if (!owner) return undefined;
        if (!owner.declaration && own?.declaration) {
            return `Package "${name}" is not bundled into ontology "${own.name}". Bundle it into "${own.name}" to use it.`;
        }
        if (!owner.declaration) {
            // Neither is an ontology, so there is nothing to bundle into yet.
            return `Package "${name}" and this package belong to no ontology, so "use" cannot join them. `
                + 'Write an ontology file that bundles both; a folder or a tonto.json does not make them one ontology.';
        }
        const file = owner.root!.uri;
        const location = file.scheme === 'file' && document.uri.scheme === 'file'
            ? relative(dirname(document.uri.fsPath), file.fsPath).split(sep).join('/') : file.toString();
        return `Package "${name}" belongs to ontology "${owner.name}", which a "use" cannot reach. `
            + `Import the ontology by location, as in \`import ${owner.name} from <${location}>\`, and qualify its names with \`${owner.name}.\`.`;
    }
}
