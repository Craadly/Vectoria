// frontend/lib/api.ts
"use client";

import axios from "axios";

// Resolve API base URL with a safe default for local dev
export function getApiBase() {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_BASE) {
    return process.env.NEXT_PUBLIC_API_BASE as string;
  }
  if (typeof window !== "undefined") {
    // If frontend served from same host with a proxy, allow relative calls
    const rel = (window as any).__VECTORIA_RELATIVE_API__;
    if (rel) return "";
  }
  return "http://localhost:3001"; // dev default
}

export const api = axios.create({
  baseURL: getApiBase(),
  timeout: 120000,
});

export type HealthStatus = {
  status: "healthy" | "degraded";
  mode: string;
  httpStatus: number;
  services: { gemini: boolean; googleAuth: boolean; recraft: boolean; recraftCredits: boolean };
  checks: { name: string; ok: boolean; reason?: string }[];
};

export async function fetchHealth(readiness = true): Promise<HealthStatus> {
  const res = await api.get("/api/health", { params: { readiness } });
  return res.data as HealthStatus;
}
