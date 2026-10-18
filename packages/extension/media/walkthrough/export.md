# Export an ontology to gUFO

The `.tonto` source already defines an ontology. This optional command checks
it and writes a gUFO-aligned Turtle representation.

From the Command Palette, the command lists the ontologies in the workspace,
with those eligible for export already selected: press Enter to export them all, or
uncheck some first. From the editor's context menu, it exports the ontology
of that file. Each ontology is written beside its ontology file, the one
holding its `ontology` header, as `<name>.ttl`; there is no destination to
choose.

An ontology whose header declares `@namespace` needs nothing more. For one
without, the command asks for its exact namespace: enter the same value you
would write after `/// @namespace`, including the final `#` or `/`. After the
export succeeds, the command adds that annotation above the `ontology` line
and saves the model, so later exports reuse it. An ontology with errors is
not written; the others still are.
