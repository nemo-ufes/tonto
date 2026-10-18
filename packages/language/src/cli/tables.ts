import { PARTHOOD_NATURE_PAIRS, PART_WHOLE_STEREOTYPES, RELATION_NATURE_TABLE, TABLE_NATURE_NAMES } from '../validation/relation-nature-table.js';
import { DEPENDENCE_ENDS, IMMUTABLE_NATURES } from '../validation/relation-nature-checks.js';
import { RELATION_STEREOTYPES, RENAMED_STEREOTYPES, RETIRED_STEREOTYPES } from '../validation/relation-stereotypes.js';
import { TIME_POINT_STEREOTYPES } from '../validation/attribute-checks.js';
import { allowedSupertypeStereotypes, CLASS_STEREOTYPES_BY_FAMILIARITY, STEREOTYPES } from '../validation/stereotype-model.js';

/** The reference tables as plain data, for a caller that has to look one up. */
export async function tablesJson(): Promise<Record<string, unknown>> {
    return {
        natures: Object.values(TABLE_NATURE_NAMES),
        classStereotypes: Object.fromEntries(CLASS_STEREOTYPES_BY_FAMILIARITY.map(stereotype => [
            stereotype,
            { ...STEREOTYPES[stereotype], specializes: allowedSupertypeStereotypes(stereotype) ?? null }
        ])),
        relationStereotypes: RELATION_STEREOTYPES,
        propertyStereotypes: {
            names: [...TIME_POINT_STEREOTYPES],
            owner: 'a class whose instances are concrete individuals -- everything but the abstract ones; never a datatype, whose instances are values',
            const: true,
            note: 'never required: a class that says nothing about its lifetime is well formed. Both on one attribute means the individual is instantaneous.'
        },
        relationEnds: RELATION_NATURE_TABLE,
        parthoodStereotypes: [...PART_WHOLE_STEREOTYPES],
        parthoodPairs: [...PARTHOOD_NATURE_PAIRS],
        immutableNatures: [...IMMUTABLE_NATURES].map(nature => TABLE_NATURE_NAMES[nature] ?? nature),
        constEnds: DEPENDENCE_ENDS,
        renamed: RENAMED_STEREOTYPES,
        retired: RETIRED_STEREOTYPES
    };
}
