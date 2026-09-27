import {PageReady} from '@/components/navigation';
import {redirect} from 'next/navigation';
import {requireAdmin,AppError} from '@/server/db';
import {Admin} from '@/components/admin/admin';
export const dynamic='force-dynamic';
export const metadata={title:'관리자',robots:{index:false,follow:false}};
export default async function Page(){let email;try{email=(await requireAdmin(false)).user.email}catch(e){if(e instanceof AppError&&[401,403].includes(e.status))redirect('/login');throw e}return <><PageReady path="/admin"/><Admin email={email||''}/></>}
