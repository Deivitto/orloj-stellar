import { betterAuth } from "better-auth";
import { magicLink, siwe } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  database,
  plugins: [
    magicLink({ sendMagicLink: async () => {} }),
    siwe({
      domain: "localhost:3000",
      anonymous: true,
      getNonce: async () => "schema-only",
      verifyMessage: async () => false,
    }),
  ],
});
const migrations = await getMigrations(auth.options);
await migrations.runMigrations();
await database.end();
console.log("Application authentication schema ready");
