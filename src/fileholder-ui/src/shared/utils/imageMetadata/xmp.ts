/**
 * XMP is XML text. Only two things are read from it: whether it records GPS coordinates, and where an Android Motion
 * Photo's video starts. Both are found with plain string search, since a full XML parser isn't needed for either.
 */

const LOCATION_PROPERTIES = ['exif:GPSLatitude', 'exif:GPSLongitude'];

/** Whether the XMP records a GPS latitude or longitude (as an attribute or as an element). */
export const xmpHasLocation = (xmp: string): boolean =>
    LOCATION_PROPERTIES.some((name) => xmp.includes(`${name}="`) || xmp.includes(`<${name}>`));

/**
 * The value of a property written either as an attribute (`name="value"`) or as an element (`<name>value</name>`),
 * within `text`; undefined when it isn't there.
 */
function propertyValue(text: string, name: string): string | undefined {
    const attribute = `${name}="`;
    const attributeAt = text.indexOf(attribute);
    if (attributeAt >= 0) {
        const start = attributeAt + attribute.length;
        const end = text.indexOf('"', start);
        return end >= 0 ? text.slice(start, end) : undefined;
    }
    const element = `<${name}>`;
    const elementAt = text.indexOf(element);
    if (elementAt >= 0) {
        const start = elementAt + element.length;
        const end = text.indexOf('<', start);
        return end >= 0 ? text.slice(start, end).trim() : undefined;
    }
    return undefined;
}

const positiveInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/** Each `<Container:Item …>` tag's text, from the newer Motion Photo format's container directory. */
const containerItems = (xmp: string): string[] =>
    xmp.split('<Container:Item').slice(1).map((rest) => rest.slice(0, Math.max(rest.indexOf('>'), 0)));

/**
 * How many bytes of video an Android Motion Photo has appended after its image, or undefined when it isn't one. The
 * video is always the last thing in the file.
 * - Newer format: a container directory item with `Item:Semantic="MotionPhoto"` and `Item:Length`.
 * - Older format: `GCamera:MicroVideoOffset`, the video's distance from the end of the file, i.e. its length.
 */
export function motionPhotoVideoLength(xmp: string): number | undefined {
    const item = containerItems(xmp).find((tag) => propertyValue(tag, 'Item:Semantic') === 'MotionPhoto');
    const fromContainer = item ? positiveInteger(propertyValue(item, 'Item:Length')) : undefined;
    return fromContainer ?? positiveInteger(propertyValue(xmp, 'GCamera:MicroVideoOffset'));
}
