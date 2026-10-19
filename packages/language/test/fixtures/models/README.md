# Model fixtures

These `.tonto` files are a snapshot adapted from the sibling
`tonto-examples` workspace on 2026-10-18. They are kept here so the language
tests run without that workspace. The sources were formatted with this
repository's `tonto format`; generated Turtle, diagrams, and example READMEs
are not part of the test corpus.

The tests use `relators` and `qualities` for single-file parsing and AST
checks, and `scientific-publications` for a bundled ontology with package
references. Every `.tonto` file here must be exactly what `tonto format`
writes, and must come back to that from flattened or over-deep indentation;
the corpus as one workspace must validate without errors; and
`npm run test:gufo-conformance` exports each of its ontologies and checks the
OWL with ROBOT and HermiT. The tests do not require every model to have zero
warnings or hints. Reformat a file after editing it, or the formatting test
fails on it.

The `endurant-types`, `objects-and-parts`, `qualities`, `relators`, `events`,
`situations`, and `higher-order-types` examples adapt models from
[gUFO's example collection](https://github.com/nemo-ufes/gufo/tree/master/examples).
The palm-oil-supply model and its diagrams are covered by its accompanying
[CC BY 4.0 notice](palm-oil-supply/LICENSE); only the model source is copied
here.
