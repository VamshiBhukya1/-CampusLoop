import multer from 'multer';
import { z } from 'zod';

const extensions = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip'
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_STUDY_FILE_SIZE_MB) || 25) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    cb(null, extensions[ext] === file.mimetype);
  }
});
const safeName = name => name.replace(/[\\/\r\n\0]/g, '_').slice(0, 255);
const validSignature = (buffer, ext) => ext === 'pdf'
  ? buffer.subarray(0, 5).toString() === '%PDF-'
  : buffer.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]));

export function registerStudyRoutes(app, { auth, admin, wrap, audit, models, storeStudyFile, openStudyFile, deleteStudyFile }) {
  const { StudyResource, StudyBookmark } = models;
  const fail = (res, status, message, code='REQUEST_ERROR') => res.status(status).json({ success:false, message, code });
  const page = req => ({ limit: Math.min(Math.max(Number(req.query.limit)||20,1),50), skip:(Math.max(Number(req.query.page)||1,1)-1)*Math.min(Math.max(Number(req.query.limit)||20,1),50) });
  const filterFor = (req, mine=false) => {
    const filter = req.user.role === 'admin' ? {} : { $or:[{moderationStatus:'approved'},{uploadedBy:req.user._id,moderationStatus:'pending'}] };
    if (mine) return { uploadedBy:req.user._id };
    const term = String(req.query.search||'').trim().slice(0,100);
    if (term) filter.$and = [...(filter.$and||[]), { $or:['title','subject','category','keywords','description'].map(key=>({[key]:{$regex:term}})) }];
    for (const key of ['category','subject','semester','extension']) if (req.query[key]) filter[key] = String(req.query[key]).slice(0,160);
    if (req.user.role === 'admin' && ['pending','approved','rejected'].includes(req.query.status)) filter.moderationStatus = req.query.status;
    if (req.user.role !== 'admin') {
      const visibility = filter.$or; delete filter.$or;
      filter.$and = [...(filter.$and||[]), { $or:visibility }];
    }
    return filter;
  };
  const sortFor = value => value === 'downloads' ? {downloadsCount:-1,createdAt:-1} : value === 'title' ? {title:1} : {createdAt:-1};

  app.get('/api/study-resources', auth, wrap(async (req,res) => {
    const filter=filterFor(req), {limit,skip}=page(req);
    const [items,total]=await Promise.all([StudyResource.find(filter).populate('uploadedBy','name').sort(sortFor(req.query.sort)).skip(skip).limit(limit),StudyResource.countDocuments(filter)]);
    const saved=new Set((await StudyBookmark.find({user:req.user._id}).select('resource')).map(x=>String(x.resource)));
    res.json({success:true,data:{items:items.map(x=>({...x.toJSON?.()||x,isBookmarked:saved.has(String(x._id))})),total,page:Math.floor(skip/limit)+1,limit}});
  }));
  app.get('/api/study-resources/mine', auth, wrap(async(req,res)=>{
    const items=await StudyResource.find({uploadedBy:req.user._id}).sort({createdAt:-1}).limit(100).populate('uploadedBy','name');
    res.json({success:true,data:{items}});
  }));
  app.get('/api/study-resources/bookmarks', auth, wrap(async(req,res)=>{
    const saved=await StudyBookmark.find({user:req.user._id}).sort({createdAt:-1}).limit(100).populate('resource');
    const items=saved.map(x=>x.resource).filter(x=>x&&(req.user.role==='admin'||x.moderationStatus==='approved'||String(x.uploadedBy)===String(req.user._id)));
    res.json({success:true,data:{items}});
  }));
  app.post('/api/study-resources', auth, upload.single('file'), wrap(async(req,res)=>{
    const d=z.object({title:z.string().trim().min(2).max(255),description:z.string().max(4000).optional().default(''),subject:z.string().trim().min(2).max(160),category:z.string().trim().min(2).max(160),semester:z.string().max(40).optional().default(''),keywords:z.string().max(500).optional().default('')}).strict().parse(req.body);
    if(!req.file)return fail(res,400,'Choose a PDF, DOCX, PPTX, or ZIP file.','INVALID_FILE');
    const extension=req.file.originalname.split('.').pop().toLowerCase();
    if(extensions[extension]!==req.file.mimetype||!validSignature(req.file.buffer,extension))return fail(res,400,'The file type does not match its contents.','INVALID_FILE');
    const storageKey=await storeStudyFile(req.file.buffer,extension);
    try {
      const item=await StudyResource.create({...d,filename:safeName(req.file.originalname),extension,mimeType:req.file.mimetype,size:req.file.size,storageKey,uploadedBy:req.user._id,moderationStatus:'pending',downloadsCount:0});
      await audit(req,'study_resource.upload','StudyResource',item._id,{extension,size:item.size});
      res.status(201).json({success:true,data:{item},message:'Upload received and awaiting moderator approval.'});
    } catch(error) { await deleteStudyFile(storageKey,extension).catch(()=>{}); throw error; }
  }));
  app.post('/api/study-resources/:id/bookmark', auth, wrap(async(req,res)=>{
    const item=await StudyResource.findById(req.params.id);
    if(!item||(!['approved'].includes(item.moderationStatus)&&String(item.uploadedBy)!==String(req.user._id)&&req.user.role!=='admin'))return fail(res,404,'Study resource not found','NOT_FOUND');
    await StudyBookmark.updateOne({user:req.user._id,resource:item._id},{$setOnInsert:{user:req.user._id,resource:item._id}},{upsert:true});
    res.json({success:true,message:'Resource saved.'});
  }));
  app.delete('/api/study-resources/:id/bookmark', auth, wrap(async(req,res)=>{
    await StudyBookmark.deleteOne({user:req.user._id,resource:req.params.id});
    res.json({success:true,message:'Resource removed from saved items.'});
  }));
  app.patch('/api/study-resources/:id/moderation', auth, admin, wrap(async(req,res)=>{
    const d=z.object({status:z.enum(['approved','rejected']),notes:z.string().max(1000).optional().default('')}).strict().parse(req.body);
    const item=await StudyResource.findOneAndUpdate({_id:req.params.id,moderationStatus:'pending'},{$set:{moderationStatus:d.status,moderationNotes:d.notes}},{new:true});
    if(!item)return fail(res,404,'Pending study resource not found','NOT_FOUND');
    await audit(req,`study_resource.${d.status}`,'StudyResource',item._id);
    res.json({success:true,data:{item}});
  }));
  app.get('/api/study-resources/:id/download', auth, wrap(async(req,res)=>{
    const item=await StudyResource.findById(req.params.id);
    if(!item||(!['approved'].includes(item.moderationStatus)&&String(item.uploadedBy)!==String(req.user._id)&&req.user.role!=='admin'))return fail(res,404,'Study resource not found','NOT_FOUND');
    const preview=req.query.preview==='true'&&item.extension==='pdf';
    if(!preview)await StudyResource.updateOne({_id:item._id},{$inc:{downloadsCount:1}});
    res.set({'Content-Type':item.mimeType,'Content-Length':item.size,'Content-Disposition':`${preview?'inline':'attachment'}; filename="${safeName(item.filename).replace(/["\\]/g,'_')}"`,'X-Content-Type-Options':'nosniff'});
    const stream=openStudyFile(item.storageKey,item.extension);
    stream.on('error',()=>{if(!res.headersSent)fail(res,404,'Stored file not found','FILE_NOT_FOUND');else res.destroy()});
    stream.pipe(res);
  }));
}
