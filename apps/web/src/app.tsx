import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { projectIdSchema, uuidSchema } from '@pi-steward/contract';
import { Empty, ErrorNotice, Loading } from './components/common';
import { Machines } from './components/machines';
import { GettingStarted, PairComputer } from './components/onboarding';
import { Project, Projects } from './components/projects';
import { Shell } from './components/shell';
import { TaskForm } from './components/task-form';
import { api, SESSION_EXPIRED } from './lib/api';
import { useI18n } from './lib/i18n';
import { projectPath, taskPath } from './lib/paths';
import { useResource } from './lib/resource';
import { Login } from './login';
import { TaskViewStateProvider, useTaskViewState } from './lib/task-view-state';

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
  return <TaskViewStateProvider><WorkspacePage key={location} projectId={project.data} taskId={task.data} location={location} logout={logout} /></TaskViewStateProvider>;
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
  const [creating, setCreating] = useTaskViewState<string | undefined>(`creating:${location}`, undefined);
  const [logoutError, setLogoutError] = useState<unknown>();
  async function tryLogout() {
    setLogoutError(undefined);
    try { await logout(); }
    catch (error) { setLogoutError(error); }
  }
  const home = location === '/' || location === '/login';
  const machinesPage = location === '/machines';
  const pairingPage = location === '/pair';
  const title = pairingPage ? t.pair.title : machinesPage ? t.common.machines
    : project?.name ?? selectedProject ?? (home ? t.common.projects : taskId ? 'Task Steward' : t.common.notFound);
  const newProject = project?.id ?? projects[0]?.id;
  function changed() {
    detail.refresh();
    projectsResource.refresh();
    machineResource.refresh();
  }

  useEffect(() => {
    document.title = `${detail.data?.task.title ?? title} · Task Steward`;
  }, [detail.data?.task.title, title]);

  return <Shell title={title} taskPage={!!taskId} back={detail.data ? projectPath(detail.data.task.projectId) : undefined}
    selectedProject={selectedProject} machinesPage={machinesPage} projects={projects} machines={machines}
    onNew={() => setCreating(newProject)} onLogout={tryLogout}>
    <ErrorNotice error={logoutError} retry={tryLogout} />
    <ErrorNotice error={projectsResource.error} retry={projectsResource.refresh} />
    <ErrorNotice error={machineResource.error} retry={machineResource.refresh} />
    {home && (projectsResource.data ? <>
      <GettingStarted collapsed={projects.length > 0} />
      <Projects projects={projects} />
    </> : !projectsResource.error && <Loading />)}
    {machinesPage && <>
      <p className="machine-entry"><Link href="/pair">{t.pair.entry}</Link></p>
      {machineResource.data ? <Machines machines={machines} /> : !machineResource.error && <Loading />}
    </>}
    {pairingPage && <PairComputer />}
    {projectId && <Project id={projectId} machines={machines} />}
    {taskId && <>
      <ErrorNotice error={detail.error} retry={detail.refresh} />
      {!detail.data && !detail.error && <Loading />}
      {detail.data && <Suspense fallback={<Loading />}>
        <TaskDetail detail={detail.data} project={project} machines={machines} onChanged={changed} />
      </Suspense>}
    </>}
    {!home && !machinesPage && !pairingPage && !projectId && !taskId && <Empty><Link href="/">{t.common.goHome}</Link></Empty>}
    {creating && <TaskForm initialProject={creating} projects={projects} machines={machines}
      focusFallback={() => {
        const main = document.querySelector<HTMLElement>('main');
        main?.setAttribute('tabindex', '-1');
        return main;
      }} onClose={() => setCreating(undefined)}
      onSaved={(task) => { setCreating(undefined); navigate(taskPath(task.id)); }} />}
  </Shell>;
}
