import { migrate,pool } from '../src/lib/db';
if(process.env.MIGRATION_DATABASE_URL) process.env.DATABASE_URL=process.env.MIGRATION_DATABASE_URL;
migrate().then(()=>{ console.info('Migrazioni completate.'); }).catch(()=>{ console.error('Migrazione non riuscita. Verificare connessione e privilegi del ruolo di migrazione.');process.exitCode=1; }).finally(()=>pool().end());
