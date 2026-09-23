// IANA Language Subtag Registry Type=language snapshot, File-Date 2026-09-17.
// qaa..qtz is expanded before encoding. The bitset covers every two- and
// three-letter lowercase primary language subtag without runtime I/O.
const PRIMARY_LANGUAGE_SUBTAG_BITS_BASE64 =
  "MzQmR8cZEAlkUwQAiBBoHIQMCZSAAkNEkMZZZVwEBIAR9GfXUBgOwG0ObaGJRCBhQEACAwAAEADAQdHd90d0m1NABAJCBAEQAAQAIAAAAEEABAJA8N/f7//+/7u9/++vf//Bc/V2OYf///8P9zvw//9cUCiX/t//9///f/f///////8/nv7//9/Eq6Dn+///7/9///////+9Qh8P33X+SXEA8t3++ZMcgv/r/v////////f/////1////3//9/////////77//////7/////+//////9/z//v//3///v//+///9////f//////f9///v/////f//vf//7///////f//321/d+gf0zxk8xIJQEgQARQQAuPsv/0krVGS9SYN4v3d+cVXV58Bx8zf//vnfhVOGAADB+//7////d+NzfPz9HxAIAFsACAACADAABAAgGQL93/fv7e9FACBA1pgR/L0nAgAA8N3mbVKePe//3//8SRHEYAgQDQB/fPZlnel12/4+ACAAAAAAfKd9JdkW4GK9R///9wcAABDAYDUAAABLeRJloQAQAAAAEZEEAAAGAQAAAAEAQEQAAAFYgAEAUAAAiEIAAABV3QJBVkMyVV/9K948AAAIAAQAAAAAQHCRE9B9lRmCeYoAEAAkCAAAQAAAACAQAARABAAA67+aAyAAAABAAAAAAAAAAgBEAAAAIAAAAAAxiFoAAAAAQABCYIpAAIAQCAUAgBBjCAQAAAAABDBQPwCBQAAAAAC+MzsBAAgQAQAAAAAAAAAAAAAA8P///////TwoCvz/ffL+UT4AASJbbFpUsjnwnf89QI0EGeAQOD5JtY0z//fflv///0eAABAQIsHz1f9Q+EQEBEDw3/9vjb5BfzPaAAAAspcncEAIAP//5w+AQRAIAAAACEHJEQAAAAAAAAEEQIBA61/KAAQAEElCwAYABv+//2fPUfD57TYAEAEAAABUUGsriEIAQBAl/t//U5CAUAAEAAAAAAEAwAAAAAAQKsB2jkSBCAJ8BHgAAADADAVEUnhECAQCAQAiAIUYAZDN7g510xGR5pC1PoMAAFIABAEAAABFZJlk3XU6eHS5DwABgAAACABUBBAgABAABAhghIC/fp9D3GkBAMBAEAAC0i0aAAAAIEEEAEAAAd9ZOUEACBAAbQEEAAEPKcYkLRCgBGBEAIAgAAACDABoAIAAAAAAAI/9XiGAAAAQAAAAAAARAAABAADwfz3e////////9//v//////////////2///+/3f///+//////////////3////c/9/////////++//////////+//3////////////v///////////7/X3/39z4tZwPJ/AP///w+AADDc92FgLgf/z/dHJALzuefR/38l///zL+9Ref//fwQYIAAAAlT1qfid7xZxGAW9/38HNFAQjcUFAAQAQSAAAKIAuHfb7+///////////v////f//////////3/////99///9/////7f+/+///////3X/3///3////+////+///////3/f/7fv//////////7/////f/////z//f//f//+n77///d/8nIEjw////f/3+/3//L+55/n//b9Xf/P///////t//3/dwGmVAfAnd9Wr63/8/1rX1////A0IBcBUlXFbfJP7//y1UWFxAIAJAlwaBUBAEEGAAAAAAABAFVkAQAABgEAECgBEgGd9/tm5QaXDVvt/UuTdIIAYEUCEEAABANZj/DeGYbPR9PxEDAAIAAAAJAAAAAKAAARAABAD/3f/b5/v8/ytEQRgG+9+lRyAAkNRCcfLfHv/7/gMAIHAM7sG/+9+/f99////PX99+RP8HERBA/Pd/353/VWD4Xn/X2wMAADAUJwQABAAQMJRBggDw///////////////////////////////////////////////////////////////////////////////////////ee37lPtGVEAwUon8RAAgAAAAA7///CzACAAIAgAAAAFM7DgEAABBBYgEQIAAzOBoABRAwGIEEAAAA//3/L6EK8YctBQAIAgAAAABEISDQAwQhBBH2xRkDAAAQwCUAAgAQACAUAAIA8Pv9//////Pt/d77//r//7cEBBHf/95///+///3/F78X//f/9+9+//77v/3//d/v93v1/xZo98l93////7/v//919fX+BYUh5v//WfFZ8dBn3BcqWX/v9//////f3/3/32//9f8DhCnwP/4/b+///f/9B+1Tscf77/v/f///f//3/+//fX/d//4C+Fv8//////n////f//v9Z/Vx94+/3fXcZ5GrvgfqAQIAI0BAgkQAAABEbUAAAEAAQAAAk2AABYAAAABAAkAAAMGNdd30QPUUb0FWraQAJAAABIAAAADA/b/+gYUURAJKAAAjASQCAAEAAAAAABAAAAAACAHx+zYJEAAAAAAAAAAADNgCAAAAAACgAAAAAGwoLAAQABDwjyEAIAH/n/cDUAIAAKAAAAAAAAAABAAxAJACAgAQAAAwCAAAABAAAAAAAAAAAAAAAADw////7OcbAQEAIBlg1BzvBRAAAENBUAURQGD/o1dAAAALCFJVd9n3HceMVz1Uf3VGEQAAAAAAwHK//UEFNohWALGIoxsAAAADQEIEAAAxECMQAAAAX/9/fc0LZ42nVwFVQEqYHgQAALCWI0UHhA4DqSYJACDw//7/VzhF//7/L999zFQvxP///wEACGzFbPG5f9P3/t9L+hpAhBHQ5aSEAIUCAw4IAUIC8P///+YfYICoAmQREFCx4hMAAAABmVYkIBAQ/vs7AAAAwX0aTeVJ9N3/6DZbBUI9jA3TAwgAAMBEH1FM+AYFIAL197t9AAACQShbBGFABAAgIRABAP/f/1cgYJEIAACAAADBMAAAAAAwCCOAQgkwAzxCAgAAsEyuY4RMFf///2cREEAIdcD///8QAAAEgRMQwCEBFG5ngTAAAQAAEAAAAAAAIEKiAAQIAAA=";

const PRIMARY_LANGUAGE_SUBTAG_BITS = Uint8Array.from(
  atob(PRIMARY_LANGUAGE_SUBTAG_BITS_BASE64),
  (character) => character.charCodeAt(0),
);

export function getPrimaryLanguageSubtag(languageTag: string): string {
  return languageTag.trim().split("-", 1)[0].toLowerCase();
}

export function isKnownPrimaryLanguageSubtag(primarySubtag: string): boolean {
  if (!/^[a-z]{2,3}$/.test(primarySubtag)) return false;

  const first = primarySubtag.charCodeAt(0) - 97;
  const second = primarySubtag.charCodeAt(1) - 97;
  const index = primarySubtag.length === 2
    ? first * 26 + second
    : 676 + first * 676 + second * 26 + (primarySubtag.charCodeAt(2) - 97);

  return (PRIMARY_LANGUAGE_SUBTAG_BITS[index >> 3] & (1 << (index & 7))) !== 0;
}
