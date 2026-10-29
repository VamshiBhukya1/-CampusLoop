import axios from 'axios';
export const api=axios.create({baseURL:import.meta.env.VITE_API_URL||'/api',withCredentials:true});
api.interceptors.response.use(response=>response,error=>{
  if(error.response?.status===401&&!String(error.config?.url||'').includes('/auth/login'))window.dispatchEvent(new Event('campusloop:unauthorized'));
  return Promise.reject(error);
});
