import PoseLabelingPage from './pages/PoseLabelingPage';
import ClassifierPage from './pages/ClassifierPage';
import AppLayout from './layouts/AppLayout';

// 앱 전체의 공통 레이아웃과 페이지 분기를 담당합니다.
export default function App() {
  const path = window.location.pathname;
  const page = path === '/classifier' ? <ClassifierPage /> : <PoseLabelingPage />;

  return <AppLayout>{page}</AppLayout>;
}
