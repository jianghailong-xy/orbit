import type { CSSProperties, ReactNode } from 'react';
import './Descriptions.css';

export interface DescriptionItem {
  key: string;
  label: ReactNode;
  children: ReactNode;
}

/**
 * Labelled values in one bordered column (the replaced description list, bordered and small): each
 * label a row header on the alternate fill, its value beside it. `labelWidth` fixes the labels'
 * column; unset, it fits the longest label.
 */
export function Descriptions({ items, labelWidth, className, style }: {
  items: DescriptionItem[];
  labelWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`orbit-descriptions${className ? ` ${className}` : ''}`} style={style}>
      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.key}>
              <th scope="row" style={labelWidth === undefined ? undefined : { width: labelWidth }}>
                {item.label}
              </th>
              <td>{item.children}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
