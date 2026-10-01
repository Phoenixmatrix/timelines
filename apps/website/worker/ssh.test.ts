import { describe, expect, test } from "vite-plus/test";
import { fingerprint, parsePublicKey, SshError, verifySshSig } from "./ssh.ts";

// Throwaway keys and signatures made with OpenSSH:
//   ssh-keygen -Y sign -n gitmatrix-auth -f <key> msg
const MESSAGE = "gitmatrix-ssh-auth\nhttp://localhost:5180\nabc123\n";
const VECTORS = {
  ed25519: {
    pub: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIIOa3waw0izXtJ+UI+PKsROdW3PfjOjra5dbbgzpSqD test-ed25519",
    sig: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAggg5rfBrDSLNe0n5Qj48qxE51bc\n9+M6Otrl1tuDOlKoMAAAAOZ2l0bWF0cml4LWF1dGgAAAAAAAAABnNoYTUxMgAAAFMAAAAL\nc3NoLWVkMjU1MTkAAABAHJJoWcCkL2tqLs4f/moj/sOUK2UBVWAC7W3lwnk5TnvveiPU2w\nbl68tTcWQGYEIQUpwB8qNU7lrjrLGEiKDCBA==\n-----END SSH SIGNATURE-----\n",
    fingerprint: "SHA256:lRHW6N02rZ7gdqb9eQN0DagMT0qMFZ8jJPb/JLEeAWY",
  },
  p256: {
    pub: "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFt1rJQRJKqFfJZgBDnMElZJEmmxbyjsQPXEnUWb5HOT3b6H/fM8cnngRp+FKcwJXbqt3alQoCbS0aTvHu6M/Qo= test-p256",
    sig: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAAGgAAAATZWNkc2Etc2hhMi1uaXN0cDI1NgAAAAhuaXN0cDI1NgAAAE\nEEW3WslBEkqoV8lmAEOcwSVkkSabFvKOxA9cSdRZvkc5Pdvof98zxyeeBGn4UpzAlduq3d\nqVCgJtLRpO8e7oz9CgAAAA5naXRtYXRyaXgtYXV0aAAAAAAAAAAGc2hhNTEyAAAAYwAAAB\nNlY2RzYS1zaGEyLW5pc3RwMjU2AAAASAAAACBsnWFem1Do4kaUsLZ3miLCYKPqZjW32xEA\n2j4gljQYcwAAACAuNJLXBDrwbC4HwLd889aklT4IYbRG1PffmB8j/YkQWQ==\n-----END SSH SIGNATURE-----\n",
    fingerprint: "SHA256:fYxezPMp+iIpyhq4u3zaoynBMYgTvzA7osjXzIXy/NE",
  },
  p384: {
    pub: "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBLHFNwcTwDGOWHw1bIzzRVXsjw43jtcltwup3mISq6lUCt8C24fDtsUufxca9u4QntEvrb7p5WWdUeeEmFoV9jFGwPo23jk+jSSP0fEcoQzTFUGDIkamwc3WTt04i4x7cA== test-p384",
    sig: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAAIgAAAATZWNkc2Etc2hhMi1uaXN0cDM4NAAAAAhuaXN0cDM4NAAAAG\nEEscU3BxPAMY5YfDVsjPNFVeyPDjeO1yW3C6neYhKrqVQK3wLbh8O2xS5/Fxr27hCe0S+t\nvunlZZ1R54SYWhX2MUbA+jbeOT6NJI/R8RyhDNMVQYMiRqbBzdZO3TiLjHtwAAAADmdpdG\n1hdHJpeC1hdXRoAAAAAAAAAAZzaGE1MTIAAACEAAAAE2VjZHNhLXNoYTItbmlzdHAzODQA\nAABpAAAAMAwOSQKUZrtRjNCZH07ELBmdlpW+4yU2Ko1LjD/lLOE7yyRga40eyVbO+J7VUD\nLr3wAAADEA/2lX7IufF/NWpWxmR0DyXzHsEYdfCqMWZY+mey7IuCbhlere9gg7EVkPQiHS\n9IVG\n-----END SSH SIGNATURE-----\n",
    fingerprint: "SHA256:yx9o1Osg0wNota1g7jQHSQ+gVj/YVI8fhxCt26/N4pM",
  },
  rsa: {
    pub: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCvjjDXALBNVC5aYzOw6MaSLCBVI1PNnW+o1zYAybyEK5u0o6jrv71jFERSkmtGD11JzromfLqTQYVH9vO0epbh90UxGwsY7LVdRzvJWs1I9NDM8VUkZQZof/qRabmC3RoGPtlbq6avLjgETE29AV37PZAryk4WprFrYIsTedNDYl+5TnSUIo1jjR3ib1fl7sXoX9L8Hp1hh8CnfvzXvXvITpw+3k8WrZsPLpyRmWjU3LhM1j2d8jbXKydHWvLgYM+lfMQqrr3fi42wVgtV2NFO2To4Sw1QxuJ+iuERJef5x4kZEXx1Bu32nYTWxcXfyepUlDWjaXKhV+c92B7nhh+x test-rsa",
    sig: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAARcAAAAHc3NoLXJzYQAAAAMBAAEAAAEBAK+OMNcAsE1ULlpjM7Doxp\nIsIFUjU82db6jXNgDJvIQrm7SjqOu/vWMURFKSa0YPXUnOuiZ8upNBhUf287R6luH3RTEb\nCxjstV1HO8lazUj00MzxVSRlBmh/+pFpuYLdGgY+2Vurpq8uOARMTb0BXfs9kCvKThamsW\ntgixN500NiX7lOdJQijWONHeJvV+Xuxehf0vwenWGHwKd+/Ne9e8hOnD7eTxatmw8unJGZ\naNTcuEzWPZ3yNtcrJ0da8uBgz6V8xCquvd+LjbBWC1XY0U7ZOjhLDVDG4n6K4REl5/nHiR\nkRfHUG7fadhNbFxd/J6lSUNaNpcqFX5z3YHueGH7EAAAAOZ2l0bWF0cml4LWF1dGgAAAAA\nAAAABnNoYTUxMgAAARQAAAAMcnNhLXNoYTItNTEyAAABADC36DDz0fVpbvjF6UbVe6x+1l\nmjKAmlcliDv8ZNQTAObpc76k4jd2nSXKaQ2iwvaJoxY8w7VhbkXYW29hILdyoS4nDSV0cQ\nsOxKccf1hAcEXz6CblZTAwRjDISUFHHlz1S6FPtL76PqZ6/gOhV805cMl8+Clpar1cd6mw\nN/RiSzYyHABnJFBETaie2YGOTUwuGYkGHK4uxlpF96G5IFwtP9QNiS6CAYNRJp1YNS056b\ns8RZkPhDMFlvFMuQiidWZ2bSoH695Hn18/NZXnQ+hnsGTJRJOcQ9hZHmsYdbEna9ukzGxh\nSDaigyGMYNdaDjDDHSb+v9TZYmt1ldjcoPhCw=\n-----END SSH SIGNATURE-----\n",
    fingerprint: "SHA256:R2dlpylFbKERupEH7EY3zJ7tMiDRkmL3MlsgYkU84b8",
  },
} as const;

describe("verifySshSig", () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    test(`accepts OpenSSH's ${name} signature`, async () => {
      const key = parsePublicKey(v.pub);
      expect(await fingerprint(key.blob)).toBe(v.fingerprint);
      expect(await verifySshSig(v.sig, MESSAGE, key)).toBe(true);
    });
  }

  test("rejects a changed message, another namespace or another key", async () => {
    const key = parsePublicKey(VECTORS.ed25519.pub);
    expect(await verifySshSig(VECTORS.ed25519.sig, `${MESSAGE}x`, key)).toBe(false);
    expect(await verifySshSig(VECTORS.ed25519.sig, MESSAGE, key, "git")).toBe(false);
    const other = parsePublicKey(VECTORS.p256.pub);
    expect(await verifySshSig(VECTORS.ed25519.sig, MESSAGE, other)).toBe(false);
  });
});

describe("parsePublicKey", () => {
  test("keeps the comment apart from the canonical text", () => {
    const key = parsePublicKey(VECTORS.rsa.pub);
    expect(key.type).toBe("ssh-rsa");
    expect(key.comment).toBe("test-rsa");
    expect(key.text.split(" ")).toHaveLength(2);
    expect(key.bits).toBe(2048);
  });

  test("refuses junk and unsupported key types", () => {
    expect(() => parsePublicKey("hello")).toThrow(SshError);
    expect(() => parsePublicKey("sk-ssh-ed25519@openssh.com AAAA")).toThrow(/Security-key/);
    const [, data] = VECTORS.ed25519.pub.split(" ");
    expect(() => parsePublicKey(`ssh-rsa ${data}`)).toThrow(/doesn't match/);
  });
});
