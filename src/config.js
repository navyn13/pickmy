import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const BUSINESS_FILE = path.join(ROOT, 'business.md');
export const PORT = Number(process.env.PORT || 3000);
export const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
export const COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '91';
