import { Pool, type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

let instance:Pool|undefined;
export function pool() {
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL non configurato');
  if(!instance) {
    instance=new Pool({connectionString:process.env.DATABASE_URL,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:10000});
    instance.on('error',()=>{console.error('Connessione database interrotta.');});
  }
  return instance;
}
export async function transaction<T>(fn:(client:PoolClient)=>Promise<T>, lock=true):Promise<T> {
  const client=await pool().connect();
  try {
    await client.query('BEGIN');
    if(lock) await client.query('SELECT pg_advisory_xact_lock(20261114)');
    const result=await fn(client);
    await client.query('COMMIT'); return result;
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function migrate() {
  await transaction(async client=>{
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir=path.join(process.cwd(),'migrations');
    for(const file of (await readdir(dir)).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) {
      if((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).rowCount) continue;
      await client.query(await readFile(path.join(dir,file),'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
    }
  });
}
