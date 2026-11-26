import { ActionIcon, Button, Drawer, NativeSelect, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { ChevronLeft, Folder, Globe, Laptop, LogOut, Menu, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'wouter';
import type { WebMachine, WebProject } from '@pi-steward/contract';
import { toggleLanguage, useI18n } from '../lib/i18n';
import { projectPath } from '../lib/paths';
import { DESKTOP_LAYOUT_QUERY } from '../lib/ui/viewport-queries';
import { usePwaDrawerTransition } from '@yefengr/pwa-foundation/mantine';
import type { PwaTextSizePreference } from '@yefengr/pwa-foundation';
import { setTextSizePreference, useTextSizePreference } from '../lib/ui/text-size';
import { Brand, ErrorNotice } from './common';
import { openCount } from './projects';

interface ShellProps {
  children: ReactNode;
  title: string;
  taskPage?: boolean;
  back?: string;
  selectedProject?: string;
  machinesPage?: boolean;
  projects: WebProject[];
  machines: WebMachine[];
  onNew: () => void;
  onLogout: () => Promise<void>;
}

function Navigation({ props, close }: { props: ShellProps; close?: () => void }) {
  const { t } = useI18n();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const textSize = useTextSizePreference();
  const [error, setError] = useState<unknown>();
  const online = props.machines.filter((machine) => machine.online).length;
  async function logout() {
    setError(undefined);
    try { await props.onLogout(); }
    catch (error) { setError(error); }
  }
  return <>
    {!close && <Brand />}
    <Button className="sidebar-new" onClick={() => { close?.(); props.onNew(); }} disabled={!props.projects.length}
      leftSection={<Plus size={16} />}>{t.common.newTask}</Button>
    <nav className="project-nav" aria-label={t.common.projects}>
      <Link className="nav-label pwa-press-row" href="/" onClick={close}>{t.common.projects}</Link>
      {props.projects.map((project) => <Link className="nav-item pwa-press-row" key={project.id} href={projectPath(project.id)} onClick={close}
        aria-current={props.selectedProject === project.id ? 'page' : undefined}>
        <Folder size={20} /><span>{project.name}</span><span className="nav-count">{openCount(project)}</span>
      </Link>)}
    </nav>
    <div className="sidebar-footer">
      <Link className="nav-item pwa-press-row" href="/machines" onClick={close} aria-current={props.machinesPage ? 'page' : undefined}>
        <Laptop size={20} /><span>{t.common.machines}</span><span className="nav-count">{online}/{props.machines.length} {t.machine.online}</span>
      </Link>
      <button className="nav-item pwa-press-row" type="button" onClick={toggleLanguage} aria-label={t.common.language}>
        <Globe size={20} /><span>{t.common.languageOption}</span>
      </button>
      <div className="sidebar-preferences">
        <NativeSelect label={t.common.theme} value={colorScheme}
          onChange={(event) => setColorScheme(event.currentTarget.value as 'auto' | 'light' | 'dark')}
          data={[{ value: 'auto', label: t.common.system }, { value: 'light', label: t.common.light }, { value: 'dark', label: t.common.dark }]} />
        <NativeSelect label={t.common.textSize} value={textSize.preference}
          onChange={(event) => setTextSizePreference(event.currentTarget.value as PwaTextSizePreference)}
          data={[...(textSize.supportsSystem ? [{ value: 'system', label: t.common.system }] : []),
            { value: 'standard', label: t.common.standard }, { value: 'large', label: t.common.large }, { value: 'xlarge', label: t.common.xlarge }]} />
      </div>
      <button className="nav-item pwa-press-row" type="button" onClick={() => void logout()}><LogOut size={20} /><span>{t.common.logout}</span></button>
      <ErrorNotice error={error} />
    </div>
  </>;
}

export function Shell(props: ShellProps) {
  const { t } = useI18n();
  const desktop = useMediaQuery(DESKTOP_LAYOUT_QUERY);
  const drawerTransition = usePwaDrawerTransition('left');
  const [menu, setMenu] = useState(false);
  const close = () => setMenu(false);
  return <div className="app-shell">
    <aside className="sidebar pwa-surface-panel"><Navigation props={props} /></aside>
    <Drawer transitionProps={drawerTransition} opened={!desktop && menu} onClose={close} title={<Brand />} classNames={{ content: 'navigation-drawer', body: 'navigation-body' }}
      size="min(300px, 86vw)" closeButtonProps={{ 'aria-label': t.common.close }}>
      <Navigation props={props} close={close} />
    </Drawer>
    <main className="main">
      <header className="mobile-topbar">
        {props.back
          ? <ActionIcon component={Link} href={props.back} variant="subtle" size={44} aria-label={t.common.back}><ChevronLeft size={20} /></ActionIcon>
          : <ActionIcon onClick={() => setMenu(true)} variant="subtle" size={44} aria-label={t.common.openMenu}><Menu size={20} /></ActionIcon>}
        {props.back && <ActionIcon onClick={() => setMenu(true)} variant="subtle" size={44} aria-label={t.common.openMenu}><Menu size={20} /></ActionIcon>}
        {props.taskPage ? <span className="mobile-page-title">{props.title}</span> : <h1 className="mobile-page-title">{props.title}</h1>}
        <ActionIcon onClick={props.onNew} disabled={!props.projects.length} variant="subtle" size={44}
          aria-label={t.common.newTask}><Plus size={22} /></ActionIcon>
      </header>
      <div className="content">
        {!props.taskPage && <h1 className="page-title">{props.title}</h1>}
        {props.children}
      </div>
    </main>
  </div>;
}
