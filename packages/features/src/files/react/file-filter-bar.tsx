import { Button } from "@hyori-cloud/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@hyori-cloud/ui/components/select";
import { Row } from "@hyori-cloud/ui/components/text";
import {
  FILE_TYPE_OPTIONS,
  hasActiveFilters,
  MODIFIED_OPTIONS,
  modifiedAfter,
  SIZE_OPTIONS,
} from "#features/files/file-filters.ts";
import type {
  FileFilters,
  FileTypeFilter,
  ModifiedFilter,
  SizeFilter,
} from "#features/files/file-filters.ts";

function FilterSelect<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { readonly value: Value; readonly label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} className="h-7 border-transparent bg-muted shadow-none" />
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FileFilterBar({
  filters,
  onChange,
  onClear,
}: {
  filters: FileFilters;
  onChange: (patch: Partial<FileFilters>) => void;
  onClear: () => void;
}) {
  return (
    <Row className="flex-wrap gap-1.5 border-b border-border px-3 py-2 md:px-4">
      <FilterSelect<FileTypeFilter>
        label="File type"
        options={FILE_TYPE_OPTIONS}
        value={filters.type}
        onChange={(type) => onChange({ type })}
      />
      <FilterSelect<ModifiedFilter>
        label="Modified"
        options={MODIFIED_OPTIONS}
        value={filters.modified}
        onChange={(modified) =>
          onChange({ modified, modifiedAfter: modifiedAfter(modified, Date.now()) })
        }
      />
      <FilterSelect<SizeFilter>
        label="Size"
        options={SIZE_OPTIONS}
        value={filters.size}
        onChange={(size) => onChange({ size })}
      />
      {hasActiveFilters(filters) ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      ) : null}
    </Row>
  );
}
