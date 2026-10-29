import './env.js';
import bcrypt from 'bcryptjs';
import {initializeDatabase,closeDatabase,models} from './db.js';

const {User,Resource,Asset}=models;
const required=['DB_HOST','DB_USER','DB_NAME','JWT_ACCESS_SECRET','BOOTSTRAP_ADMIN_EMAIL','BOOTSTRAP_ADMIN_PASSWORD'];
try {
  for(const key of required)if(!process.env[key])throw new Error(`Set ${key} before running the seed.`);
  if(process.env.NODE_ENV==='production'&&(/replace|example|changeme/i.test(process.env.BOOTSTRAP_ADMIN_PASSWORD)||process.env.BOOTSTRAP_ADMIN_PASSWORD.length<16))throw new Error('Set a unique bootstrap password of at least 16 characters in production.');
  await initializeDatabase();
  const email=process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const existing=await User.findOne({email});
  if(!existing)await User.create({name:'CampusLoop Administrator',email,passwordHash:await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD,12),role:'admin',status:'active'});
  const samples=[
    {assetId:'BOOK-101',name:'The Design of Everyday Things',type:'book',category:'Design',author:'Don Norman',isbn:'9780465050659',location:'Library · A2',totalCopies:3},
    {assetId:'EQ-201',name:'Portable Projector',type:'equipment',category:'AV equipment',location:'Media Desk',totalCopies:1},
    {assetId:'SP-301',name:'Innovation Lab',type:'space',category:'Laboratory',location:'Engineering · 2F',capacity:24,totalCopies:1}
  ];
  for(const item of samples){
    let resource=await Resource.findOne({assetId:item.assetId});
    if(!resource){resource=await Resource.create({...item,availableCopies:item.totalCopies});for(let i=0;i<item.totalCopies&&['book','equipment'].includes(item.type);i++)await Asset.create({resource:resource._id,assetTag:`${item.assetId}-${String(i+1).padStart(3,'0')}`,location:item.location});}
  }
  console.log(`MySQL initialization complete. Bootstrap admin ready: ${email}.`);
} catch(error) { console.error(error.message);process.exitCode=1; }
finally { await closeDatabase(); }
