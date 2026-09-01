import { encodeBase64Url } from "@std/encoding";
console.log(encodeBase64Url(new Uint8Array([1,2,3,250,251,252])));
