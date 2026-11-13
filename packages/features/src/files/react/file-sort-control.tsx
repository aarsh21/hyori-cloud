import { ArrowUpDown } from "@hyori-cloud/lib/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@hyori-cloud/ui/components/select";
import { FILE_SORT_OPTIONS } from "#features/files/react/file-sort.ts";
import type { FileSort } from "#features/files/react/file-sort.ts";

export function FileSortControl({
  value,
  onChange,
}: {
  value: FileSort;
  onChange: (sort: FileSort) => void;
}) {
  return (
    <Select
      items={FILE_SORT_OPTIONS}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger
        aria-label="Sort files"
        title={FILE_SORT_OPTIONS.find((option) => option.value === value)?.label}
        className="min-w-8 justify-center border-transparent bg-transparent px-2 shadow-none coarse:min-w-11 [&>span:last-child]:hidden"
      >
        <ArrowUpDown aria-hidden className="size-4" />
        <span className="hidden md:inline">Sort</span>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-52">
        {FILE_SORT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
