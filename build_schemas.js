/*
 * Copyright 2020 Charles Tatibouët
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { castArray, has, set, sortBy } = require("lodash");
const cheerio = require("cheerio");
const prettier = require("prettier");
const chalk = require("chalk");
const HttpStatus = require("http-status-codes");
const hardcodedSchemas = require("./hardcoded-schemas.json");
const propertyMultiplicity = require("./property-multiplicity.json");

const schemaOrgSchemasUrl =
  "https://schema.org/version/latest/schemaorg-current-https.jsonld";
const schemaOrgDraftVersion = "https://json-schema.org/draft/2020-12/schema";
const schemasDir = path.join(__dirname, "schemas");
const schemaSuffix = ".schema.json";
const typesWithoutMultiplicity = new Set(["Boolean"]);
const inferredMultiplicity = new Set();
const rootSchema = "Thing";

/**
 * Perform a GET request
 *
 * @param uri {string} - The URI to fetch from
 * @returns {Promise<string>} - The fetched data
 */
async function fetch(uri) {
  const response = await axios.get(uri);
  if (response.status !== HttpStatus.OK) {
    throw new Error(`Error while fetching '${uri}': ${response.statusText}`);
  }
  return response.data;
}

/**
 * Check if a label has a hardcoded schema
 *
 * @param label {string} - The label to check
 * @returns {boolean} - True if the label has a hardcoded schema
 */
function hasHardcodedSchema(label) {
  return Object.prototype.hasOwnProperty.call(hardcodedSchemas, label);
}

/**
 * Check if a property has a hardcoded multiplicity
 *
 * @param propertyLabel {string} - The property to check
 * @returns {boolean} - True if the property has a hardcoded multiplicity
 */
function hasHardcodedMultiplicity(propertyLabel) {
  return Object.prototype.hasOwnProperty.call(
    propertyMultiplicity,
    propertyLabel,
  );
}

/**
 * Convert HTML to plain text
 *
 * @param html {string} - The HTML to convert
 * @returns {string} - The plain text version of the HTML
 */
function htmlToPlainText(html) {
  return cheerio.load(html).text();
}

/**
 * Build a JSON Schema object representing the parents of a Schema.org class
 *
 * @param parentsIDs {string[]} - The Schema.org @id of the parents
 * @param allSchemaClasses {object[]} - All the Schema.org classes in JSON-LD format
 * @returns {object} - The object representing the parents in JSON Schema format
 */
function buildParents(parentsIDs, allSchemaClasses) {
  const parents = allSchemaClasses.filter((type) =>
    parentsIDs.includes(type["@id"]),
  );
  return sortBy(parents, ["rdfs:label"]).map((parent) => ({
    description: htmlToPlainText(parent["rdfs:comment"]),
    $ref: parent["@id"],
  }));
}

/**
 * Build a JSON Schema type from a Schema.org type
 *
 * @param type {object} - The Schema.org type in JSON-LD format
 * @returns {object} - The corresponding type in JSON Schema format
 */
function buildType(type) {
  const typeLabel = type["rdfs:label"];
  return hasHardcodedSchema(typeLabel)
    ? hardcodedSchemas[`${typeLabel}`]
    : {
        $ref: type["@id"],
      };
}

/**
 * Build multiple JSON Schema types from Schema.org types
 *
 * @param types {object[]} - The Schema.org types in JSON-LD format
 * @param isArray {boolean} - True if the property can have multiple values
 * @returns {object} - The corresponding types in JSON Schema format
 */
function buildTypes(types, isArray) {
  if (types.length > 1) {
    const possibleTypes = {
      anyOf: sortBy(
        types.map((type) => buildType(type)),
        ["type", "format", "$ref"],
      ),
    };
    if (isArray) {
      return {
        oneOf: [
          possibleTypes,
          {
            type: "array",
            items: possibleTypes,
          },
        ],
      };
    }
    return possibleTypes;
  }
  const typeLabel = types[0]["rdfs:label"];
  const type = buildType(types[0]);
  return isArray && !typesWithoutMultiplicity.has(typeLabel)
    ? {
        oneOf: [
          type,
          {
            type: "array",
            items: type,
          },
        ],
      }
    : type;
}

/**
 * Get the properties of a Schema.org class
 *
 * @param id {string} - The ID of the Schema.org class
 * @param allProperties {object[]} - All the Schema.org properties in JSON-LD format
 * @returns {object[]} - The properties of the Schema.org class in JSON-LD format
 */
function getProperties(id, allProperties) {
  return allProperties.filter(
    (property) =>
      has(property, "schema:domainIncludes") &&
      castArray(property["schema:domainIncludes"]).some(
        (parent) => parent["@id"] === id,
      ),
  );
}

/**
 * Build JSON Schema properties from Schema.org properties
 *
 * @param properties {object[]} - The Schema.org properties in JSON-LD format
 * @param allSchemaClasses {object[]} - All the Schema.org classes in JSON-LD format
 * @returns {object} - The object representing the properties in JSON Schema format
 */
function buildProperties(properties, allSchemaClasses) {
  return properties.reduce((accumulator, property) => {
    const propertyLabel =
      typeof property["rdfs:label"] === "string"
        ? property["rdfs:label"]
        : property["rdfs:label"]["@value"];
    const propertyDescription = htmlToPlainText(property["rdfs:comment"]);
    if (hasHardcodedSchema(propertyLabel)) {
      set(accumulator, [propertyLabel], {
        description: propertyDescription,
        ...hardcodedSchemas[`${propertyLabel}`],
      });
      return accumulator;
    }
    const types = allSchemaClasses.filter((_schemaClass) =>
      castArray(property["schema:rangeIncludes"]).some(
        (possibleType) => possibleType["@id"] === _schemaClass["@id"],
      ),
    );
    if (types.length > 0) {
      let isArray;
      if (hasHardcodedMultiplicity(propertyLabel)) {
        isArray = propertyMultiplicity[`${propertyLabel}`];
      } else {
        isArray = !propertyDescription.startsWith("The ");
        inferredMultiplicity.add(propertyLabel);
      }
      set(accumulator, [propertyLabel], {
        description: propertyDescription,
        ...buildTypes(types, isArray),
      });
    } else if (hasHardcodedSchema(propertyLabel)) {
      set(accumulator, [propertyLabel], {
        description: propertyDescription,
        ...hardcodedSchemas[`${propertyLabel}`],
      });
    } else {
      console.error(chalk.red(`Unknown type for property ${propertyLabel}`));
    }
    return accumulator;
  }, {});
}

/**
 * Build a JSON Schema from a Schema.org class
 *
 * @param schemaClass {object} - The Schema.org class in JSON-LD format
 * @param allSchemaClasses {object[]} - All the Schema.org classes in JSON-LD format
 * @param allProperties {object[]} - All the Schema.org properties in JSON-LD format
 * @param enumValues {object[]} - All the Schema.org enum values in JSON-LD format
 * @returns {object} - The generated JSON Schema
 */
function buildSchema(schemaClass, allSchemaClasses, allProperties, enumValues) {
  const id = schemaClass["@id"];
  const title =
    schemaClass["rdfs:label"] &&
    typeof schemaClass["rdfs:label"].valueOf() === "string"
      ? schemaClass["rdfs:label"]
      : schemaClass["rdfs:label"]["@value"];
  const description = htmlToPlainText(schemaClass["rdfs:comment"]);
  const schema = {
    $schema: schemaOrgDraftVersion,
    $id: id,
    title,
    description,
    type: "object",
  };
  if (has(schemaClass, "rdfs:subClassOf")) {
    const parentsIDs = castArray(schemaClass["rdfs:subClassOf"]).map(
      (parent) => parent["@id"],
    );
    if (parentsIDs.includes("schema:Enumeration")) {
      const enumMembers = enumValues.filter(
        (enumValue) => enumValue["@type"] === id,
      );
      if (enumMembers.length > 0) {
        schema.type = "string";
        schema.oneOf = sortBy(enumMembers, ["rdfs:label"]).map(
          (enumMember) => ({
            description: htmlToPlainText(enumMember["rdfs:comment"]),
            const: enumMember["rdfs:label"],
          }),
        );
      }
    } else {
      const parents = buildParents(parentsIDs, allSchemaClasses);
      if (parents.length > 0) {
        schema.allOf = parents;
      }
    }
  }
  if (title === rootSchema) {
    schema.properties = {
      "@context": {
        type: "string",
      },
      "@type": {
        type: "string",
      },
    };
  }
  const propertiesToBuild = getProperties(id, allProperties);
  const properties = buildProperties(
    sortBy(propertiesToBuild, ["rdfs:label"]),
    allSchemaClasses,
  );
  for (const [propertyLabel, property] of Object.entries(properties)) {
    set(schema, ["properties", propertyLabel], property);
  }
  return schema;
}

/**
 * Generate JSON Schemas from all the Schema.org classes
 *
 * @returns {Promise<void>} - Completion of the generation
 */
async function main() {
  const jsonld = await fetch(schemaOrgSchemasUrl);
  const graph = jsonld["@graph"];
  const schemaClasses = graph.filter((vocabulary) =>
    castArray(vocabulary["@type"]).includes("rdfs:Class"),
  );
  const properties = graph.filter((vocabulary) =>
    castArray(vocabulary["@type"]).includes("rdf:Property"),
  );
  const enumValues = graph.filter((vocabulary) =>
    castArray(vocabulary["@type"]).some(
      (type) => type.startsWith("schema:") && type !== "schema:DataType",
    ),
  );
  await fs.ensureDir(schemasDir);
  for (const schemaClass of schemaClasses.filter(
    (schema) => !castArray(schema["@type"]).includes("schema:DataType"),
  )) {
    const schema = buildSchema(
      schemaClass,
      schemaClasses,
      properties,
      enumValues,
    );
    const filename = `${schema.title}${schemaSuffix}`;
    fs.writeFileSync(
      path.join(schemasDir, filename),
      prettier.format(JSON.stringify(schema), { parser: "json" }),
    );
  }
  return schemaClasses.length;
}

/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then */

if (require.main === module) {
  main()
    .then((schemasCount) => {
      for (const propertyName of Array.from(inferredMultiplicity).sort()) {
        console.warn(
          chalk.yellow(`Multiplicity of property ${propertyName} was inferred`),
        );
      }
      console.log(
        chalk.green(
          `Built ${schemasCount} schema${schemasCount > 1 ? "s" : ""}`,
        ),
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

/* eslint-enable promise/prefer-await-to-callbacks, promise/prefer-await-to-then */

module.exports = { main, buildSchema };
