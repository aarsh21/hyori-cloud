import type { ComponentProps, ReactNode } from "react";
import { ChevronRight, FileText, Star } from "lucide-react";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { Button } from "@hyori-cloud/ui/components/button";

export function NoteWorkspace({
  sidebar,
  children,
  opened,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  opened: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        aria-label="Notes library"
        className={cn(
          "flex w-64 shrink-0 flex-col border-r border-border bg-card max-lg:w-56 max-md:w-full",
          opened && "max-md:hidden",
        )}
      >
        {sidebar}
      </aside>
      <section
        aria-label="Note"
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-card",
          !opened && "max-md:hidden",
        )}
      >
        {children}
      </section>
    </div>
  );
}

export function NoteListItem({
  name,
  depth,
  favorite,
  current,
  expanded,
  hasChildren,
  onToggle,
  ...props
}: ComponentProps<typeof AppLink> & {
  name: string;
  depth: number;
  favorite: boolean;
  current: boolean;
  expanded: boolean;
  hasChildren: boolean;
  onToggle(): void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-0.5" style={{ paddingLeft: depth * 12 }}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
        aria-expanded={hasChildren ? expanded : undefined}
        disabled={!hasChildren}
        onClick={onToggle}
        className={!hasChildren ? "invisible" : undefined}
      >
        <ChevronRight className={cn(expanded && "rotate-90")} />
      </Button>
      <AppLink
        {...props}
        aria-current={current ? "page" : undefined}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground coarse:h-11"
      >
        <FileText aria-hidden className="size-3.5 shrink-0 stroke-[1.5]" />
        <span className="truncate">{name}</span>
        {favorite && (
          <Star aria-label="Favorite" className="ml-auto size-3 shrink-0 fill-current" />
        )}
      </AppLink>
    </div>
  );
}

export function NoteCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-10 pb-16 md:px-10 md:pt-16">{children}</div>
  );
}
