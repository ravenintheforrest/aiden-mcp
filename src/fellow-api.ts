/**
 * Fellow Aiden API client.
 *
 * Talks to the same private API the official Fellow iOS app uses.
 * No public docs — endpoints discovered from the iOS app traffic.
 * Could change without notice.
 *
 * Auth model: each MCP request brings its own Fellow email/password
 * via headers, we exchange them for a JWT, use it for one batch of
 * calls, discard. Nothing is stored server-side.
 */

const BASE_URL = "https://l8qtmnc692.execute-api.us-west-2.amazonaws.com/v1";
const USER_AGENT = "Fellow/5 CFNetwork/1568.300.101 Darwin/24.2.0";

export interface FellowProfile {
  id?: string;
  profileType: number;
  title: string;
  ratio: number;
  bloomEnabled: boolean;
  bloomRatio: number;
  bloomDuration: number;
  bloomTemperature: number;
  ssPulsesEnabled: boolean;
  ssPulsesNumber: number;
  ssPulsesInterval: number;
  ssPulseTemperatures: number[];
  batchPulsesEnabled: boolean;
  batchPulsesNumber: number;
  batchPulsesInterval: number;
  batchPulseTemperatures: number[];
}

export interface FellowDevice {
  id: string;
  displayName?: string;
}

export class FellowApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "FellowApiError";
  }
}

export class FellowClient {
  private token: string | null = null;
  private deviceId: string | null = null;
  private deviceName: string | null = null;

  constructor(
    private email: string,
    private password: string,
  ) {}

  private headers(): HeadersInit {
    const h: HeadersInit = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async authenticate(): Promise<void> {
    const r = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const body = (await r.json()) as { accessToken?: string; message?: string };
    if (!body.accessToken) {
      throw new FellowApiError(
        body.message || "Login failed (check Fellow email/password)",
        r.status,
        body,
      );
    }
    this.token = body.accessToken;
  }

  async getDevice(): Promise<FellowDevice> {
    if (this.deviceId) return { id: this.deviceId, displayName: this.deviceName ?? undefined };
    const r = await fetch(`${BASE_URL}/devices?dataType=real`, {
      headers: this.headers(),
    });
    const devices = (await r.json()) as FellowDevice[];
    if (!devices?.length) {
      throw new FellowApiError("No Aiden device found on this Fellow account", r.status);
    }
    const d = devices[0];
    this.deviceId = d.id;
    this.deviceName = d.displayName ?? null;
    return d;
  }

  async listProfiles(): Promise<FellowProfile[]> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles`, {
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError(`Failed to list profiles`, r.status, await r.text());
    }
    return (await r.json()) as FellowProfile[];
  }

  async createProfile(profile: Omit<FellowProfile, "id">): Promise<FellowProfile> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(profile),
    });
    const body = (await r.json()) as FellowProfile & { message?: string; error?: string };
    if (!body.id) {
      // Common case: 14-profile cap
      if (typeof body.message === "string" && body.message.includes("maximum number of profiles")) {
        throw new FellowApiError(
          "Aiden has reached its 14-profile cap. Delete an old profile first using delete_profile.",
          r.status,
          body,
        );
      }
      throw new FellowApiError(body.message || "Failed to create profile", r.status, body);
    }
    return body;
  }

  async deleteProfile(profileId: string): Promise<void> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles/${profileId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError(
        `Failed to delete profile ${profileId}`,
        r.status,
        await r.text(),
      );
    }
  }

  async shareProfile(profileId: string): Promise<string> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles/${profileId}/share`, {
      method: "POST",
      headers: this.headers(),
    });
    const body = (await r.json()) as { link?: string; message?: string };
    if (!body.link) {
      throw new FellowApiError(body.message || "Failed to generate brew.link", r.status, body);
    }
    return body.link;
  }

  /**
   * Find a profile by id OR title (case-sensitive). Returns null if not found.
   */
  async findProfile(idOrTitle: string): Promise<FellowProfile | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.id === idOrTitle || p.title === idOrTitle) ?? null;
  }
}
