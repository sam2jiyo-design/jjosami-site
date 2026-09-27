import {PageReady} from '@/components/navigation';
import {NavLink} from '@/components/navigation';
export default function NotFound(){return <><PageReady/><div className="route-error"><h1>페이지를 찾을 수 없습니다</h1><NavLink href="/" className="btn primary">홈으로 이동</NavLink></div></>}
