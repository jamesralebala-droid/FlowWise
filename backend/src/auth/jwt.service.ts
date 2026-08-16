import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface RoleClaim {
  branchId: string | null;
  role: string;
}

export interface JwtPayloadClaims {
  sub: string;
  org: string;
  perms: string[];
  roles: RoleClaim[];
  /** bound device id, if any */
  dev: string | null;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export class JwtService {
  constructor(
    private readonly secret: Uint8Array,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly ttlSeconds: number,
  ) {}

  async sign(input: {
    sub: string;
    org: string;
    perms: string[];
    roles: RoleClaim[];
    dev: string | null;
  }): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({
      org: input.org,
      perms: input.perms,
      roles: input.roles,
      dev: input.dev,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(input.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.secret);
    return { token, expiresIn: this.ttlSeconds };
  }

  async verify(token: string): Promise<JwtPayloadClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: this.issuer,
      audience: this.audience,
    });
    return payload as unknown as JwtPayloadClaims;
  }
}
