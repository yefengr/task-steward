import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { projectIdSchema, uuidSchema } from '@pi-steward/contract';
import { Empty, ErrorNotice, Loading } from './components/common';
import { Machines } from './components/machines';
import { Project, Projects } from './components/projects';
import { Shell } from './components/shell';
import { TaskForm } from './components/task-form';
import { api, SESSION_EXPIRED } from './lib/api';
import { useI18n } from './lib/i18n';
import { projectPath, taskPath } from './lib/paths';
import { useResource } from './lib/resource';
import { Login } from './login';

const TaskDetail = lazy(() => import('./components/task-detail'));

export function App() {
  const [session, setSession] = useState<'active' | 'inactive' | 'expired'>();
  const auth = useResource(api.me, false);
  const [location, navigate] = useLocation();
  useEffect(() => {
    const expire = () => setSession('expired');
    window.addEventListener(SESSION_EXPIRED, expire);
    return () => window.removeEventListener(SESSION_EXPIRED, expire);
  }, []);
  if (!session && !auth.data) return auth.error ? <main className="center-page"><ErrorNotice error={auth.error} retry={auth.refresh} /></main> : <Loading />;
  if (session === 'active' || (!session && auth.data?.authenticated)) return <Workspace logout={async () => {
    await api.logout();
    setSession('inactive');
  }} />;
  // 登录表单显示在当前地址，Cookie 建立后直接恢复原来的深链。
  return <Login expired={session === 'expired'} onLogin={() => {
    if (location === '/login') navigate('/', { replace: true });
    setSession('active');
  }} />;
}

function Workspace({ logout }: { logout: () => Promise<void> }) {
  const [location] = useLocation();
  const [, projectMatch] = useRoute('/projects/:id');
  const [, taskMatch] = useRoute('/tasks/:id');
  const task = uuidSchema.safeParse(taskMatch?.id);
  const project = projectIdSchema.safeParse(projectMatch?.id);
  return <WorkspacePage key={location} projectId={project.data} taskId={task.data} location={location} logout={logout} />;
}

function WorkspacePage({ projectId, taskId, location, logout }: {
  projectId?: string; taskId?: string; location: string; logout: () => Promise<void>;
}) {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const projectsResource = useResource(api.projects);
  const machineResource = useResource(api.machines);
  const detail = useResource(taskId ? (signal) => api.task(taskId, signal) : async () => undefined, !!taskId);
  const projects = projectsResource.data?.projects ?? [];
  const machines = machineResource.data?.machines ?? [];
  const selectedProject = projectId ?? detail.data?.task.projectId;
  const project = projects.find((project) => project.id === selectedProject);
  const [creating, setCreating] = useState<string>();
  const [logoutError, setLogoutError] = useState<unknown>();
  async function tryLogout() {
    setLogoutError(undefined);
    try { await logout(); }
    catch (error) { setLogoutError(error); }
  }
  const home = location === '/' || location === '/login';
  const machinesPage = location === '/machines';
  const title = machinesPage ? t.common.machines : project?.name ?? selectedProject ?? (home ? t.common.projects : taskId ? 'Pi Steward' : t.common.notFound);
  const newProject = project?.id ?? projects[0]?.id;
  function changed() {
    detail.refresh();
    projectsResource.refresh();
    machineResource.refresh();
  }

  useEffect(() => {
    document.title = `${detail.data?.task.title ?? title} · Pi Steward`;
  }, [detail.data?.task.title, title]);

  return <Shell title={title} taskPage={!!taskId} back={detail.data ? projectPath(detail.data.task.projectId) : undefined}
    selectedProject={selectedProject} machinesPage={machinesPage} projects={projects} machines={machines}
    onNew={() => setCreating(newProject)} onLogout={tryLogout}>
    <ErrorNotice error={logoutError} retry={tryLogout} />
    <ErrorNotice error={projectsResource.error} retry={projectsResource.refresh} />
    <ErrorNotice error={machineResource.error} retry={machineResource.refresh} />
    {home && (projectsResource.data ? <Projects projects={projects} /> : !projectsResource.error && <Loading />)}
    {machinesPage && (machineResource.data ? <Machines machines={machines} /> : !machineResource.error && <Loading />)}
    {projectId && <Project id={projectId} machines={machines} />}
    {taskId && <>
      <ErrorNotice error={detail.error} retry={detail.refresh} />
      {!detail.data && !detail.error && <Loading />}
      {detail.data && <Suspense fallback={<Loading />}>
        <TaskDetail detail={detail.data} project={project} machines={machines} onChanged={changed} />
      </Suspense>}
    </>}
    {!home && !machinesPage && !projectId && !taskId && <Empty><Link href="/">{t.common.goHome}</Link></Empty>}
    {creating && <TaskForm initialProject={creating} projects={projects} machines={machines} onClose={() => setCreating(undefined)}
      onSaved={(task) => { setCreating(undefined); navigate(taskPath(task.id)); }} />}
  </Shell>;
}
