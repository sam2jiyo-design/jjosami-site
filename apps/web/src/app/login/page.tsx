import {PageReady} from '@/components/navigation';
import {Login} from '@/components/admin/login';
export const metadata={title:'관리자 로그인',robots:{index:false,follow:false}};
export default function Page(){return <><PageReady path="/login"/><Login/></>}
