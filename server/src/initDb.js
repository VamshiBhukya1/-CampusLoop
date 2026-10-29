import './env.js';
import {initializeDatabase,closeDatabase} from './db.js';
try{await initializeDatabase();console.log(`CampusLoop schema is ready in MySQL database ${process.env.DB_NAME}.`)}catch(error){console.error(error.message);process.exitCode=1}finally{await closeDatabase()}
