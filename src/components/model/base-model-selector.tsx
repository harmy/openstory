import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { ChevronDown } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

type ModelItem = {
  id: string;
  name: string;
  group: string;
  badge?: 'open-source' | 'proprietary';
};

type BaseModelSelectorProps = {
  label: string;
  models: ModelItem[];
  groupOrder: readonly string[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
  multiSelect?: boolean;
};

export const BaseModelSelector: React.FC<BaseModelSelectorProps> = ({
  label,
  models,
  groupOrder,
  selectedIds,
  onSelectionChange,
  disabled = false,
  multiSelect = false,
}) => {
  const [open, setOpen] = useState(false);
  const [multipleEnabled, setMultipleEnabled] = useState(
    selectedIds.length > 1
  );

  // Group models by their group field
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelItem[]>();
    for (const model of models) {
      if (!groups.has(model.group)) {
        groups.set(model.group, []);
      }
      groups.get(model.group)?.push(model);
    }
    return Object.fromEntries(groups);
  }, [models]);

  const isMultiActive = multiSelect && multipleEnabled;

  const handleToggle = useCallback(
    (modelId: string, checked: boolean) => {
      if (disabled) return;

      if (!isMultiActive) {
        // Single select mode — pick this model
        if (checked) {
          onSelectionChange([modelId]);
        }
      } else {
        // Multi select mode
        if (checked) {
          onSelectionChange([...selectedIds, modelId]);
        } else {
          // Ensure at least one remains
          if (selectedIds.length > 1) {
            onSelectionChange(selectedIds.filter((id) => id !== modelId));
          }
        }
      }
    },
    [selectedIds, onSelectionChange, disabled, isMultiActive]
  );

  const handleMultipleToggle = useCallback(
    (enabled: boolean) => {
      setMultipleEnabled(enabled);
      // When turning off multiple, snap to just the first selected model
      if (!enabled && selectedIds.length > 1) {
        onSelectionChange([selectedIds[0]]);
      }
    },
    [selectedIds, onSelectionChange]
  );

  // Display label for button
  const displayLabel = useMemo(() => {
    if (selectedIds.length === 0) {
      return `Select ${label.toLowerCase()}`;
    }

    const firstModel = models.find((m) => m.id === selectedIds[0]);
    const firstName = firstModel?.name ?? 'Unknown';

    if (selectedIds.length === 1) {
      return firstName;
    }

    return `${firstName} +${selectedIds.length - 1}`;
  }, [selectedIds, models, label]);

  // Format group label (capitalize, format nicely)
  const formatGroupLabel = (group: string) => {
    return group
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const showGroupHeaders = groupOrder.length > 1;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between"
          disabled={disabled}
        >
          <span className="text-sm truncate">{displayLabel}</span>
          <ChevronDown className="ml-2 size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[260px] max-h-[400px] overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-xs">{label}</DropdownMenuLabel>
          {multiSelect && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="multi-toggle"
                className="text-[10px] text-muted-foreground"
              >
                Multiple
              </label>
              <Switch
                id="multi-toggle"
                size="sm"
                checked={multipleEnabled}
                onCheckedChange={handleMultipleToggle}
              />
            </div>
          )}
        </div>
        <DropdownMenuSeparator />
        {groupOrder.map((groupKey, groupIndex) => {
          const groupModels = groupedModels[groupKey];
          if (groupModels.length === 0) return null;

          return (
            <DropdownMenuGroup key={groupKey}>
              {groupIndex > 0 && <DropdownMenuSeparator />}
              {showGroupHeaders && (
                <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
                  {formatGroupLabel(groupKey)}
                </DropdownMenuLabel>
              )}
              {groupModels.map((model) => {
                const isSelected = selectedIds.includes(model.id);
                const isDisabled = isMultiActive
                  ? isSelected && selectedIds.length === 1
                  : isSelected;

                return (
                  <DropdownMenuCheckboxItem
                    key={model.id}
                    checked={isSelected}
                    onCheckedChange={(checked) =>
                      handleToggle(model.id, checked)
                    }
                    onSelect={(e) => e.preventDefault()}
                    disabled={isDisabled}
                    className="cursor-pointer"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span className="truncate">{model.name}</span>
                      {model.badge === 'open-source' && (
                        <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                          Open Source
                        </span>
                      )}
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
