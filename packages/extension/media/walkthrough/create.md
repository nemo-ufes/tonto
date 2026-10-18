# Start an ontology in a folder

Open a folder in VS Code; no configuration file or package installation is
required. A workspace folder can contain several ontologies. Start with one
`.tonto` file: its `ontology` header, then its declarations.

```tonto
ontology people

/// A person, in the everyday sense.
kind Person
```

When the model outgrows one file, run **Tonto: New Package...**. It splits
the one-file ontology first -- its declarations move to package "core" -- and
then writes the new package file. The ontology file keeps the header, which
now lists the ontology's packages after `bundles`;
each package file starts `package core in people`, and `use core` lets one
package refer to another. The ontology file is the one other ontologies
import. The optional `tonto.json` configures workspace import locations; it
does not determine which files belong to an ontology.
