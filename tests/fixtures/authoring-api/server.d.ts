/** The unconventional location `spec: "link"` serves the document from. */
export declare const LINKED_SPEC_PATH = "/internal/service-description";
/**
 * @param {{ spec?: "path"|"link"|"none", faults?: { republishSucceeds?: boolean },
 *           prefix?: string }} [options]
 * @returns {Promise<{ url, origin, requests, faults, close }>}
 */
export declare function startAuthoringApi({ spec, faults, prefix }?: LegacyTestValue): Promise<{
    url: string;
    origin: string;
    requests: any;
    faults: any;
    specPath: any;
    close: () => Promise<void>;
}>;
/** The approved rule statements a test hands the authoring loop for this fixture. */
export declare const AUTHORING_RULES: readonly (Readonly<{
    id: "lifecycle";
    title: "Publication is one-way and refuses repetition";
    statement: "A widget is created in status \"draft\", publishing moves it to \"published\", and publishing an already-published widget is refused with 409.";
    applicability: "Every widget, however it was created.";
}> | Readonly<{
    id: "deletion";
    title: "A deleted widget is gone";
    statement: "A deleted widget answers 404 on read and does not appear in the listing.";
}>)[];
