import {useEffect,useState} from 'react';
import './BookingModal.css';

function localDateTimeValue(date){
  const offset=date.getTimezoneOffset()*60_000;
  return new Date(date.getTime()-offset).toISOString().slice(0,16);
}

export default function BookingModal({resource,api,onClose,onCreated}){
  const initialStart=new Date(Date.now()+60*60_000);
  const [start,setStart]=useState(localDateTimeValue(initialStart));
  const [end,setEnd]=useState(localDateTimeValue(new Date(initialStart.getTime()+60*60_000)));
  const [rules,setRules]=useState(null);
  const [loadingRules,setLoadingRules]=useState(true);
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  useEffect(()=>{
    let active=true;
    api.get('/booking-rules').then(response=>{
      if(active)setRules(response.data.data.bookingRules);
    }).catch(reason=>{
      if(active)setError(reason.response?.data?.message||'Could not load booking rules. Please try again.');
    }).finally(()=>{if(active)setLoadingRules(false)});
    return()=>{active=false};
  },[api]);

  useEffect(()=>{
    const onKeyDown=event=>{if(event.key==='Escape'&&!submitting)onClose()};
    window.addEventListener('keydown',onKeyDown);
    return()=>window.removeEventListener('keydown',onKeyDown);
  },[onClose,submitting]);

  useEffect(()=>{
    document.body.classList.add('modal-open');
    return()=>document.body.classList.remove('modal-open');
  },[]);

  function validate(){
    const startDate=new Date(start),endDate=new Date(end),now=Date.now();
    if(!Number.isFinite(startDate.getTime())||startDate.getTime()<=now)return 'Choose a start time in the future.';
    if(!Number.isFinite(endDate.getTime())||endDate<=startDate)return 'End time must be after the start time.';
    if(rules){
      if(startDate.getTime()-now>Number(rules.maxAdvanceDays)*86_400_000)return `Bookings can be made up to ${rules.maxAdvanceDays} days in advance.`;
      if(endDate-startDate>Number(rules.maxDurationHours)*3_600_000)return `Booking duration cannot exceed ${rules.maxDurationHours} hours.`;
    }
    return '';
  }

  async function submit(event){
    event.preventDefault();setError('');setSuccess('');
    const validationError=validate();if(validationError){setError(validationError);return}
    setSubmitting(true);
    try{
      await api.post('/bookings',{resourceId:resource._id,kind:'space',start:new Date(start).toISOString(),end:new Date(end).toISOString()});
      setSuccess('Booking request submitted. You can follow its status in Requests.');
      onCreated();
    }catch(reason){setError(reason.response?.data?.message||'Could not submit your booking. Please try again.')}finally{setSubmitting(false)}
  }

  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!submitting)onClose()}}>
    <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-title">
      <div className="booking-modal__header">
        <div><small>SPACE RESERVATION</small><h2 id="booking-title">Book a space</h2><p className="muted">{resource.name}</p></div>
        <button className="modal-close" type="button" aria-label="Close booking dialog" onClick={onClose} disabled={submitting}>×</button>
      </div>
      <form onSubmit={submit}>
        <div className="booking-modal__fields">
          <label>Start Date &amp; Time<input type="datetime-local" value={start} onChange={event=>setStart(event.target.value)} required disabled={loadingRules||submitting||Boolean(success)}/></label>
          <label>End Date &amp; Time<input type="datetime-local" value={end} onChange={event=>setEnd(event.target.value)} required disabled={loadingRules||submitting||Boolean(success)}/></label>
        </div>
        {loadingRules&&<p className="muted" role="status">Loading booking rules…</p>}
        {rules&&<p className="muted booking-hint">Up to {rules.maxDurationHours} hours per booking · book up to {rules.maxAdvanceDays} days ahead.</p>}
        {error&&<p className="error" role="alert">{error}</p>}
        {success&&<p className="success" role="status">{success}</p>}
        <div className="booking-modal__actions">
          <button className="secondary" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary" type="submit" disabled={loadingRules||submitting||Boolean(success)||!rules}>
            {submitting?'Submitting…':success?'Booking requested':'Confirm Booking'}
          </button>
        </div>
      </form>
    </section>
  </div>;
}
