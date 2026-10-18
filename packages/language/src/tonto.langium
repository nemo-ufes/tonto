grammar Tonto

import "./grammar/terminals";
import "./grammar/common";
import "./grammar/stereotypes";
import "./grammar/natures";
import "./grammar/classifiers";
import "./grammar/datatypes";
import "./grammar/attributes";
import "./grammar/relations";
import "./grammar/gensets";
import "./grammar/modules";

entry Model returns Model:
    (imports+=Import | packages+=Package | ontologies+=Ontology packages+=OntologyBody?)*
;
