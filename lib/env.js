import { loadEnvFile } from "node:process";

loadEnvFile(new URL("../.env", import.meta.url));

export function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value == null || value === "") {
    return fallback;
  }
  return value;
}

export function getEnvNumber(name, fallback) {
  const value = Number(getEnv(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

export function getEnvBool(name, fallback = false) {
  const value = getEnv(name);
  if (value == null) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
