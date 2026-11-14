import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type AcpModeOptionItem = {
    id: string;
    name: string;
    description?: string;
};

type AcpModeSelectorProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    options: readonly AcpModeOptionItem[];
    currentModeId: string | null;
    onSelectMode: (modeId: string) => void;
    compact?: boolean;
};

export const AcpModeSelector = React.memo(function AcpModeSelector(props: AcpModeSelectorProps) {
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        options,
        currentModeId,
        onSelectMode,
        compact = false,
    } = props;

    const currentOption = React.useMemo(
        () => options.find((opt) => opt.id === currentModeId) ?? options[0] ?? null,
        [currentModeId, options],
    );
    const label = currentOption ? `Mode: ${currentOption.name}` : 'Session mode';

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            data-testid="acp-mode-selector"
                            disabled={!isInteractive || options.length === 0}
                            className={cn(
                                footerIconButtonClass,
                                !compact && 'w-auto px-1.5 gap-1 rounded-md hover:bg-[var(--interactive-hover)]',
                                !isInteractive && 'opacity-30',
                            )}
                            onMouseDown={(event) => {
                                event.preventDefault();
                            }}
                            onPointerDownCapture={(event) => {
                                if (event.pointerType === 'touch') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }
                            }}
                            aria-label={label}
                        >
                            <Icon name="shield-user" className={cn(iconSizeClass, 'text-current shrink-0')} />
                            {!compact && currentOption ? (
                                <span className="typography-meta max-w-24 truncate text-foreground/80">
                                    {currentOption.name}
                                </span>
                            ) : null}
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                    <span>{label}</span>
                </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" side="top" className="min-w-48 max-w-72">
                {options.map((option) => {
                    const isSelected = option.id === currentOption?.id;
                    return (
                        <DropdownMenuItem
                            key={option.id}
                            data-testid={`acp-mode-option-${option.id}`}
                            onSelect={() => onSelectMode(option.id)}
                            className="flex items-start justify-between gap-2"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="typography-meta font-medium text-foreground truncate">
                                    {option.name}
                                </div>
                                {option.description ? (
                                    <div className="typography-micro text-muted-foreground line-clamp-2">
                                        {option.description}
                                    </div>
                                ) : null}
                            </div>
                            {isSelected ? (
                                <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
                            ) : null}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
});
