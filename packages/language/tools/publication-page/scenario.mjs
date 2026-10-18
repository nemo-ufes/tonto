/**
 * The files the publication guide follows, and the prose that is not derived.
 * Everything the tools say about them is captured by `build.mjs`.
 */

/** The published dependency, as its host serves it. */
export const PEOPLE = {
    url: 'https://example.org/people/people.tonto',
    source: `/// People, as the shop's suppliers publish them.
///
/// @namespace https://example.org/people#
/// @version 1.0.0
ontology people

kind Person`,
    next: `/// People, as the shop's suppliers publish them.
///
/// @namespace https://example.org/people#
/// @version 1.1.0
ontology people

kind Person
kind Organization`
};

/** The ontology being published: its ontology file and the packages it bundles. */
export const SHOP = {
    'shop.tonto': `/// What the shop sells, and to whom.
///
/// @namespace https://example.org/shop#
/// @version 1.2.0
ontology shop bundles
    catalog from <catalog/products.tonto>
    sales from <sales/orders.tonto>`,
    'catalog/products.tonto': `package catalog in shop

kind Product`,
    'sales/orders.tonto': `package sales in shop

use catalog
import people from <https://example.org/people/people.tonto>

role Customer specializes people.Person
relator Order {
    @mediation [1..*] -- [1] (const) Customer
    @mediation [0..*] -- [1..*] (const) catalog.Product
}`
};

/** A local copy of the dependency, for development. */
export const MAPPING = { locations: { 'https://example.org/people/': '../people/' } };

/** Two complete ontologies in one folder, one file each. */
export const LOOSE = {
    'people.tonto': 'ontology people\n\nkind Person',
    'customers.tonto': 'ontology customers\n\nkind Person'
};

/** A package that says it belongs to an ontology whose ontology file does not list it. */
export const MEMBERS = {
    'shop.tonto': 'ontology shop bundles\n    catalog from <catalog.tonto>',
    'catalog.tonto': 'package catalog in shop\n\nkind Product',
    'returns.tonto': 'package returns in shop\n\nkind Parcel'
};
