import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './lib/supabase';
import {
  Zap, Clock, Target, User, AlertTriangle, Search, Filter,
  ChevronRight, MoreVertical, MessageSquare, Send, CheckCircle,
  RefreshCcw, Calendar, TrendingUp, Users, MapPin, ExternalLink,
  Download, X, Phone, Bot, History, Activity, Globe, Sun, Moon,
  Trash2, BarChart2, Megaphone, LifeBuoy, LayoutDashboard, AlertCircle
} from 'lucide-react';
import { formatDistanceToNow, parseISO, differenceInMinutes, startOfDay, isWithinInterval, subDays, subMinutes, subHours } from 'date-fns';
import { ResponsiveContainer, Tooltip as RechartsTooltip, BarChart, Bar, XAxis, YAxis, Cell, PieChart, Pie } from 'recharts';
import { ingestLead } from './lib/ingestion';

// --- Constants ---
const STATUSES = ['new', 'contacted', 'follow_up', 'ipd_done', 'lost', 'pushed_to_crm'];
const REPS = ['Anjali', 'Deepak', 'Siddharth', 'Priyanka', 'Rahul'];
const CITIES = ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Pune'];

const COLORS = {
  primary: '#6366f1',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  orange: '#f97316',
  indigo: '#818cf8',
  slate: '#64748b',
  rose: '#f43f5e'
};

// --- Helper Functions ---
const getTargetIntent = (lead) => {
  const intent = String(lead.intent_level || '').toLowerCase();
  if (intent === 'referral' || lead.lead_type === 'referral') return { label: 'REFERRAL', class: 'intent-referral' };
  if (intent === 'hot') return { label: 'HOT 🔥', class: 'intent-hot' };
  if (intent === 'warm') return { label: 'WARM', class: 'intent-warm' };
  return { label: 'COLD ❄️', class: 'intent-cold' };
};

const getSLAStyle = (createdAt) => {
  if (!createdAt) return { text: 'N/A', class: 'time-60plus', minutes: 999, color: COLORS.slate };
  const diff = differenceInMinutes(new Date(), parseISO(createdAt));

  if (diff <= 5) return { text: `${diff}m`, class: 'time-0-5', minutes: diff, color: COLORS.success };
  if (diff <= 20) return { text: `${diff}m`, class: 'time-5-20', minutes: diff, color: COLORS.warning };
  if (diff <= 60) return { text: `${diff}m`, class: 'time-20-60', minutes: diff, color: COLORS.orange };

  const timeText = diff >= 1440 ? `${Math.floor(diff / 1440)}d` : diff >= 60 ? `${Math.floor(diff / 60)}h` : `${diff}m`;
  return { text: timeText, class: 'time-60plus', minutes: diff, color: COLORS.danger };
};

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState('dark');
  const [activeTab, setActiveTab] = useState('leads');
  const [searchPhone, setSearchPhone] = useState('');
  const [selectedCity, setSelectedCity] = useState(null);
  const [selectedIntent, setSelectedIntent] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedTime, setSelectedTime] = useState('All');
  const [activeChartFilter, setActiveChartFilter] = useState(null);
  const [selectedLead, setSelectedLead] = useState(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isAutoPushing, setIsAutoPushing] = useState(false);
  const [autoPushStatus, setAutoPushStatus] = useState(null);
  const [dashboardFilter, setDashboardFilter] = useState(null); // { type: 'priority' | 'intent' | 'action' | 'funnel', value: string, label: string }

  // --- Auth Logic ---
  useEffect(() => {
    const auth = localStorage.getItem("auth");
    if (auth === "true") setIsAuthenticated(true);
  }, []);

  const handleLogin = (username, password) => {
    if (!import.meta.env.VITE_ADMIN_USERNAME || !import.meta.env.VITE_ADMIN_PASSWORD) {
      alert("Login not configured properly");
      return;
    }
    if (
      username === import.meta.env.VITE_ADMIN_USERNAME &&
      password === import.meta.env.VITE_ADMIN_PASSWORD
    ) {
      setIsAuthenticated(true);
      localStorage.setItem("auth", "true");
    } else {
      alert("Invalid credentials");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("auth");
    setIsAuthenticated(false);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000); // 8s refresh

    const channel = supabase
      .channel('leads-arrival')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads_surgery' }, (payload) => {
        fetchData();
      })
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  async function fetchData() {
    console.log("[FRONTEND] Fetching leads from 'leads_surgery'...");
    const { data, error } = await supabase.from('leads_surgery').select('*').order('created_at', { ascending: false });
    console.log("ALL LEADS FROM DB:", data?.length, data);
    if (!error) setLeads(data);
    setLoading(false);
  }

  const handleUpdateLead = async (id, updates) => {
    const { error } = await supabase.from('leads_surgery').update(updates).eq('id', id);
    if (error) alert(error.message);
    else fetchData();
  };

  const appendRemark = async (id, currentRemarks, newNote, author = 'Rep') => {
    if (!newNote.trim()) return;
    const timestamp = new Date().toLocaleString();
    const formattedNote = `[${timestamp}] [${author}] ${newNote}`;
    const updated = currentRemarks ? `${currentRemarks}\n${formattedNote}` : formattedNote;
    await handleUpdateLead(id, { remarks: updated });
  };

  const toggleChartFilter = (key, value) => {
    if (activeChartFilter?.key === key && activeChartFilter?.value === value) setActiveChartFilter(null);
    else setActiveChartFilter({ key, value });
  };

  const handleDashboardFilter = (type, value, label) => {
    if (dashboardFilter?.type === type && dashboardFilter?.value === value) {
      setDashboardFilter(null);
    } else {
      setDashboardFilter({ type, value, label });
    }
  };

  const clearDashboardFilter = () => setDashboardFilter(null);

  const enrichedLeads = useMemo(() => {
    return leads.map(l => {
      const lastActivity = parseISO(l.created_at);
      const now = new Date();
      const hoursSinceActivity = (now - lastActivity) / (1000 * 60 * 60);
      const isOverdue = l.status !== 'pushed_to_crm' && l.status !== 'lost' && hoursSinceActivity > 4;

      return {
        ...l,
        _intent: getTargetIntent(l),
        _sla: getSLAStyle(l.created_at),
        isOverdue
      };
    });
  }, [leads]);

  const filteredLeads = useMemo(() => {
    return enrichedLeads.filter(l => {
      const matchesPhone = !searchPhone || l.phone_number?.includes(searchPhone);
      const matchesCity = !selectedCity || l.city === selectedCity;
      const matchesIntent = !selectedIntent || l._intent.label.includes(selectedIntent.toUpperCase());

      // Sales Workflow Filter Logic
      let matchesWorkflow = true;
      if (selectedStatus === 'Call Requested') matchesWorkflow = l.request_call;
      else if (selectedStatus === 'Pending Follow-up') matchesWorkflow = l.status === 'follow_up' || l.status === 'contacted';
      else if (selectedStatus === 'Ready for CRM') matchesWorkflow = l.status !== 'pushed_to_crm' && l.parameters_completed >= 3;
      else if (selectedStatus === 'Action Required') matchesWorkflow = l.request_call || l.parameters_completed < 4 || (l.intent_level === 'hot' && l.status !== 'pushed_to_crm');

      let matchesDate = true;
      if (selectedTime !== 'All') {
        const leadDate = parseISO(l.created_at);
        const now = new Date();
        if (selectedTime === 'Last 30 min') matchesDate = leadDate >= subMinutes(now, 30);
        else if (selectedTime === 'Last 1 hour') matchesDate = leadDate >= subHours(now, 1);
        else if (selectedTime === 'Today') matchesDate = leadDate >= startOfDay(now);
      }

      let matchesChart = true;
      if (activeChartFilter) {
        const { key, value } = activeChartFilter;
        if (key === 'freshness') {
          const m = l._sla.minutes;
          if (value === '0-30m') matchesChart = m <= 30;
          else if (value === '30-60m') matchesChart = m > 30 && m <= 60;
          else if (value === '1-6h') matchesChart = m > 60 && m <= 360;
          else if (value === '6-24h') matchesChart = m > 360 && m <= 1440;
          else if (value === '1-5d') matchesChart = m > 1440;
        } else if (key === 'sla') {
          matchesChart = l._sla.color === (value === 'Within' ? COLORS.success : value === 'Approaching' ? COLORS.warning : COLORS.danger);
        } else if (key === 'intent') {
          matchesChart = l._intent.label.includes(value.toUpperCase());
        } else if (key === 'source') {
          matchesChart = l.source === value;
        } else if (key === 'status') {
          matchesChart = l.status === value;
        }
      }

      let matchesDashboard = true;
      if (dashboardFilter) {
        const { type, value } = dashboardFilter;
        if (type === 'priority') {
          if (value === 'REFERRAL') matchesDashboard = l._intent.label.includes('REFERRAL');
          else matchesDashboard = l._intent.label.includes(value.toUpperCase());
        } else if (type === 'intent') {
          if (value === 'Cost') matchesDashboard = l.interest_cost;
          else if (value === 'Recovery') matchesDashboard = l.interest_recovery;
          else if (value === 'Eligibility') matchesDashboard = l.is_eligible || l.parameters_completed >= 3;
          else if (value === 'General') matchesDashboard = !l.interest_cost && !l.interest_recovery && !l.is_eligible && l.parameters_completed < 3;
        } else if (type === 'action') {
          if (value === 'Call Req') matchesDashboard = l.request_call;
          else if (value === 'Pending Follow-up') matchesDashboard = l.status === 'follow_up' || l.status === 'contacted';
          else if (value === 'Ready for CRM') matchesDashboard = l.status !== 'pushed_to_crm' && l.parameters_completed >= 3;
          else if (value === 'Overdue') matchesDashboard = l.isOverdue;
        } else if (type === 'funnel') {
          if (value === 'New Leads') matchesDashboard = l.status === 'new';
          else if (value === 'Qualified') matchesDashboard = l.parameters_completed >= 3;
          else if (value === 'Contacted') matchesDashboard = l.status === 'contacted' || l.status === 'follow_up';
          else if (value === 'Converted') matchesDashboard = l.status === 'pushed_to_crm';
        }
      }

      const matchesStatus = !selectedStatus || l.status === selectedStatus;

      return matchesPhone && matchesCity && matchesIntent && matchesDate && matchesChart && matchesWorkflow && matchesDashboard;
    });
  }, [enrichedLeads, searchPhone, selectedCity, selectedIntent, selectedStatus, selectedTime, activeChartFilter, dashboardFilter]);

  // Metrics derived from dashboard_metrics view
  const summaryMetrics = useMemo(() => {
    return {
      hot: enrichedLeads.filter(l => l._intent.label.includes('HOT')).length,
      callRequests: enrichedLeads.filter(l => l.request_call).length,
      pending: enrichedLeads.filter(l => l.status === 'new' || l.status === 'follow_up').length,
      total: enrichedLeads.length,
      totalActive: enrichedLeads.filter(l => l.status !== 'lost').length
    };
  }, [enrichedLeads]);

  // --- Chart Data Calculations ---
  const intentData = useMemo(() => {
    const counts = { Cost: 0, Recovery: 0, Eligibility: 0, General: 0 };
    enrichedLeads.forEach(l => {
      if (l.interest_cost) counts.Cost++;
      else if (l.interest_recovery) counts.Recovery++;
      else if (l.is_eligible) counts.Eligibility++;
      else counts.General++;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [enrichedLeads]);

  const priorityData = useMemo(() => {
    const counts = { HOT: 0, WARM: 0, COLD: 0, REFERRAL: 0 };
    enrichedLeads.forEach(l => {
      const label = l._intent.label;
      if (label.includes('HOT')) counts.HOT++;
      else if (label.includes('WARM')) counts.WARM++;
      else if (label.includes('REFERRAL')) counts.REFERRAL++;
      else counts.COLD++;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [enrichedLeads]);

  const actionData = useMemo(() => {
    const counts = { 'Call Req': 0, 'Pending Follow-up': 0, 'Ready for CRM': 0, 'Overdue': 0 };
    enrichedLeads.forEach(l => {
      if (l.isOverdue) counts['Overdue']++;
      if (l.request_call) counts['Call Req']++;
      else if (l.status === 'follow_up' || l.status === 'contacted') counts['Pending Follow-up']++;
      else if (l.status !== 'pushed_to_crm' && l.parameters_completed >= 3) counts['Ready for CRM']++;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [enrichedLeads]);


  const funnelData = useMemo(() => {
    const total = enrichedLeads.length || 1;
    const stages = [
      { label: 'New Leads', value: enrichedLeads.filter(l => l.status === 'new').length, color: 'var(--primary)' },
      { label: 'Qualified', value: enrichedLeads.filter(l => l.parameters_completed >= 3).length, color: 'var(--indigo)' },
      { label: 'Contacted', value: enrichedLeads.filter(l => l.status === 'contacted' || l.status === 'follow_up').length, color: 'var(--accent)' },
      { label: 'Converted', value: enrichedLeads.filter(l => l.status === 'pushed_to_crm').length, color: 'var(--success)' }
    ];
    
    const maxVal = Math.max(...stages.map(s => s.value)) || 1;
    return stages.map(s => ({ ...s, percentage: (s.value / maxVal) * 100 }));
  }, [enrichedLeads]);

  const VisualFunnel = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {funnelData.map((stage, i) => (
        <div 
          key={stage.label} 
          className={`funnel-step fade-in ${dashboardFilter?.value === stage.label ? 'active' : ''}`} 
          style={{ animationDelay: `${i * 0.1}s`, cursor: 'pointer' }}
          onClick={() => handleDashboardFilter('funnel', stage.label, stage.label)}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', alignItems: 'flex-end', padding: '0 4px' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>{stage.label}</span>
            <span style={{ fontSize: '0.9rem', fontWeight: '900', color: stage.color }}>{stage.value}</span>
          </div>
          <div style={{ height: '24px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--glass-border)', position: 'relative' }}>
            <div style={{ 
              width: `${stage.percentage}%`, 
              height: '100%', 
              background: `linear-gradient(90deg, ${stage.color}22, ${stage.color})`,
              transition: 'width 1s cubic-bezier(0.4, 0, 0.2, 1)',
              borderRadius: '0 4px 4px 0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: '8px'
            }}>
              <div style={{ fontSize: '0.6rem', fontWeight: '900', color: '#fff', opacity: stage.percentage > 10 ? 1 : 0 }}>{stage.percentage.toFixed(0)}%</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const CustomDonut = ({ data, title, colors, type }) => (
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: '16px' }}>
      <div style={{ height: '140px', width: '140px', position: 'relative' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              innerRadius={45}
              outerRadius={60}
              paddingAngle={5}
              dataKey="value"
              stroke="none"
              animationDuration={1000}
              onClick={(e) => handleDashboardFilter(type, e.name, e.name)}
              style={{ cursor: 'pointer' }}
            >
              {data.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={colors[index % colors.length]} 
                  opacity={dashboardFilter?.value === entry.name ? 1 : dashboardFilter ? 0.3 : 1}
                  className="chart-segment"
                />
              ))}
            </Pie>
            <RechartsTooltip 
              contentStyle={{ background: 'var(--panel-bg)', borderRadius: '12px', border: '1px solid var(--glass-border)', boxShadow: '0 10px 30px rgba(0,0,0,0.3)', fontSize: '0.8rem' }}
              itemStyle={{ color: 'var(--text-main)', fontWeight: '700' }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
          <div style={{ fontSize: '1.25rem', fontWeight: '900', color: 'var(--text-main)', lineHeight: 1 }}>
            {data.reduce((a, b) => a + b.value, 0)}
          </div>
          <div style={{ fontSize: '0.55rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginTop: '2px' }}>{title}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {data.map((entry, index) => (
          <div 
            key={entry.name} 
            style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', opacity: dashboardFilter?.value === entry.name ? 1 : dashboardFilter ? 0.4 : 0.8 }}
            onClick={() => handleDashboardFilter(type, entry.name, entry.name)}
          >
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: colors[index % colors.length] }} />
            <span style={{ fontSize: '0.7rem', fontWeight: '700', color: 'var(--text-main)' }}>{entry.name}</span>
            <span style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-muted)' }}>({entry.value})</span>
          </div>
        ))}
      </div>
    </div>
  );

  const handleAutoPush = async () => {
    if (filteredLeads.length === 0) return alert('No leads to push.');
    if (!window.confirm(`You are about to push ${filteredLeads.length} leads to CRM. Continue?`)) return;

    setIsAutoPushing(true);
    setAutoPushStatus({ total: filteredLeads.length, success: 0, failed: 0, processing: true });

    try {
      const apiUrl = import.meta.env.VITE_CRM_API_URL || 'http://localhost:3000';
      const crmKey = import.meta.env.VITE_CRM_API_KEY || 'relive_crm_secure_key_2026';

      const response = await fetch(`${apiUrl}/api/push-to-crm-form`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-crm-key': crmKey
        },
        body: JSON.stringify({ leads: filteredLeads })
      });

      const data = await response.json();
      if (data.status === 'success') {
        setAutoPushStatus({
          total: data.processed,
          success: data.success_count,
          failed: data.failed_count,
          processing: false
        });
        fetchData();
      } else {
        throw new Error(data.message);
      }
    } catch (err) {
      console.error(err);
      alert('Automatic push failed: ' + err.message);
      setAutoPushStatus(prev => ({ ...prev, processing: false }));
    } finally {
      setIsAutoPushing(false);
    }
  };
  const handleBulkExport = async () => {
    if (filteredLeads.length === 0) return alert('No leads to export.');
    if (!window.confirm(`Export ${filteredLeads.length} leads to CSV?`)) return;

    setIsExporting(true);
    try {
      const headers = ['Contact Name', 'Phone', 'Customer City', 'State', 'Customer Country', 'Lead Source', 'Status', 'Last Internal Note', 'Assignee'];
      const csv = [
        headers.join(','),
        ...filteredLeads.map(l => [
          `"${l.contact_name || ''}"`,
          `"${l.phone_number || ''}"`,
          `"${l.city || ''}"`,
          `"${l.state || ''}"`,
          `"${l.country || ''}"`,
          `"${l.source || ''}"`,
          `"${l.status || ''}"`,
          `"${String(l.remarks || '').replace(/"/g, '""')}"`,
          `"${l.assignee || ''}"`
        ].join(','))
      ].join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `refrens_crm_export_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
    } catch (err) {
      console.error(err);
      alert('Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleBulkAssign = async () => {
    const assignee = window.prompt(`Enter assignee name or phone for ${filteredLeads.length} filtered leads:`);
    if (assignee === null) return;

    setLoading(true);
    try {
      const { error } = await supabase.from('leads_surgery')
        .update({ assignee })
        .in('id', filteredLeads.map(l => l.id));

      if (error) throw error;
      alert(`Assigned ${filteredLeads.length} leads to ${assignee || 'Unassigned'}`);
      fetchData();
    } catch (err) {
      alert('Bulk assignment failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };


  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--bg-dark)' }}>
      <RefreshCcw size={48} className="spin" color="var(--primary)" />
      <div style={{ fontWeight: '700', letterSpacing: '0.1em', fontSize: '1rem', color: 'var(--text-muted)' }}>SYNCING DATA...</div>
    </div>
  );


  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900" style={{ 
        height: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'radial-gradient(circle at top right, #1e293b, #0f172a)'
      }}>
        <div className="glass-panel" style={{ 
          padding: '40px', 
          width: '400px', 
          background: 'rgba(30, 41, 59, 0.7)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '24px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{ 
              width: '64px', 
              height: '64px', 
              background: 'rgba(99, 102, 241, 0.1)', 
              borderRadius: '20px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              margin: '0 auto 16px',
              border: '1px solid rgba(99, 102, 241, 0.2)'
            }}>
              <LayoutDashboard size={32} color="#6366f1" />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '800', color: '#f8fafc', letterSpacing: '-0.025em' }}>Admin Login</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '4px' }}>Secure access to Relive Cure Portal</p>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Username</label>
              <input 
                id="login-username" 
                placeholder="Enter username" 
                className="search-field"
                style={{ width: '100%', height: '48px', background: 'rgba(15, 23, 42, 0.5)', padding: '0 16px' }} 
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>Password</label>
              <input 
                id="login-password" 
                type="password" 
                placeholder="••••••••" 
                className="search-field"
                style={{ width: '100%', height: '48px', background: 'rgba(15, 23, 42, 0.5)', padding: '0 16px' }} 
              />
            </div>
            <button
              className="btn-primary"
              style={{ width: '100%', height: '48px', marginTop: '12px', fontSize: '1rem', justifyContent: 'center' }}
              onClick={() =>
                handleLogin(
                  document.getElementById("login-username").value,
                  document.getElementById("login-password").value
                )
              }
            >
              Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="command-center fade-in" style={{ padding: '40px' }}>
      <header className="nav-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)', marginBottom: '4px' }}>
              <Zap size={16} fill="currentColor" />
              <span style={{ fontWeight: '800', letterSpacing: '0.1em', fontSize: '0.65rem', textTransform: 'uppercase' }}>LASIK Control</span>
            </div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: '900', letterSpacing: '-0.02em' }}>
              Relive <span style={{ color: 'var(--primary)' }}>Cure</span>
            </h1>
          </div>

          <div style={{ display: 'flex', gap: '4px', background: 'var(--glass-bg)', padding: '4px', borderRadius: '12px', border: '1px solid var(--glass-border)' }}>
            <button className={`tab-btn active`} onClick={() => setActiveTab('leads')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <LayoutDashboard size={16} /> Leads
              </div>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn-icon" onClick={toggleTheme} style={{ width: '40px', height: '40px' }}>
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button 
            className="btn-primary" 
            style={{ 
              background: 'rgba(239, 68, 68, 0.1)', 
              color: '#ef4444', 
              border: '1px solid rgba(239, 68, 68, 0.2)', 
              padding: '0 16px',
              height: '40px',
              fontSize: '0.85rem'
            }} 
            onClick={handleLogout}
          >
             <X size={16} /> Logout
          </button>
          
          <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', height: '40px' }}>
            <div className="dot active pulse-primary" />
            <span style={{ fontSize: '0.75rem', fontWeight: '800' }}>LIVE</span>
          </div>
        </div>
      </header>

      {activeTab === 'leads' && (
        <div className="fade-in">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '20px', marginBottom: '32px' }}>
            {[
              { label: '🔥 HOT LEADS', value: summaryMetrics.hot, color: 'var(--hot)' },
              { label: '📞 CALL REQ', value: summaryMetrics.callRequests, color: 'var(--hot)' },
              { label: '🕐 PENDING FOLLOW-UPS', value: summaryMetrics.pending, color: 'var(--warm)' },
              { label: '📊 TOTAL LEADS', value: summaryMetrics.total, color: 'var(--accent)' }
            ].map(m => (
              <div key={m.label} className="glass-panel metric-card" style={{ padding: '24px', borderLeft: `4px solid ${m.color}` }}>
                <span className="metric-label" style={{ fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.05em' }}>{m.label}</span>
                <span className="metric-value" style={{ fontSize: '2.5rem', fontWeight: '900', color: m.color }}>{m.value}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '24px' }}>
            <div className="action-card" onClick={() => handleDashboardFilter('priority', 'HOT', 'HOT Leads')}>
              <div className="action-count">{summaryMetrics.hot}</div>
              <div className="action-label">Hot Leads<br/>Needs Pitch</div>
            </div>
            <div className="action-card" onClick={() => handleDashboardFilter('action', 'Call Req', 'Call Requests')}>
              <div className="action-count">{summaryMetrics.callRequests}</div>
              <div className="action-label">Call Requests<br/>Call Back Now</div>
            </div>
            <div className="action-card" onClick={() => handleDashboardFilter('action', 'Overdue', 'Overdue Leads')}>
              <div className="action-count">{enrichedLeads.filter(l => l.isOverdue).length}</div>
              <div className="action-label">Overdue<br/>Move or Lose</div>
            </div>
            <div className="action-card" onClick={() => handleDashboardFilter('action', 'Ready for CRM', 'Ready for CRM')}>
              <div className="action-count">{enrichedLeads.filter(l => l.status !== 'pushed_to_crm' && l.parameters_completed >= 3).length}</div>
              <div className="action-label">Ready for CRM<br/>Push to Sales</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '32px' }}>
            <div className="glass-panel" style={{ padding: '24px', flex: '0 0 320px', display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '20px', letterSpacing: '0.05em' }}>Sales Pipeline Funnel</span>
              <VisualFunnel />
              {funnelData.some(s => s.value > 0 && s.label !== 'Converted') && (
                <div className="insight-card fade-in">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning)', marginBottom: '4px' }}>
                    <AlertCircle size={14} />
                    <span style={{ fontWeight: '800', fontSize: '0.7rem' }}>BOTTLENECK DETECTED</span>
                  </div>
                  {funnelData.filter(s => s.label !== 'Converted' && s.value > 0).sort((a,b) => b.value - a.value).slice(0,1).map(s => (
                    <div key={s.label}><b>{s.value} leads</b> stuck at <b>{s.label}</b> stage.</div>
                  ))}
                </div>
              )}
            </div>

            <div className="glass-panel" style={{ padding: '24px', flex: 1, display: 'flex', justifyContent: 'space-between', gap: '20px' }}>
              <CustomDonut title="Intents" type="intent" data={intentData} colors={['#3B82F6', '#818CF8', '#10B981', 'var(--glass-border)']} />
              <div style={{ width: '1px', background: 'var(--glass-border)', height: '70%', alignSelf: 'center' }} />
              <CustomDonut title="Priority" type="priority" data={priorityData} colors={['var(--hot)', 'var(--warm)', 'var(--cold)']} />
              <div style={{ width: '1px', background: 'var(--glass-border)', height: '70%', alignSelf: 'center' }} />
              <CustomDonut title="Requirements" type="action" data={actionData} colors={['var(--hot)', 'var(--warm)', 'var(--primary)', '#f43f5e']} />
            </div>
          </div>

          <div className="glass-panel" style={{ padding: '20px', marginBottom: '24px', display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ position: 'relative', width: '220px' }}>
              <Search size={16} style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search phone..."
                className="search-field"
                style={{ paddingLeft: '44px', height: '44px' }}
                value={searchPhone}
                onChange={e => setSearchPhone(e.target.value)}
              />
            </div>

            <select className="search-field" style={{ width: '150px', height: '44px' }} value={selectedIntent || 'All'} onChange={e => setSelectedIntent(e.target.value === 'All' ? null : e.target.value)}>
              <option value="All">All Priority</option>
              {['HOT', 'WARM', 'COLD'].map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            <select className="search-field" style={{ width: '200px', height: '44px' }} value={selectedStatus || 'All'} onChange={e => setSelectedStatus(e.target.value === 'All' ? null : e.target.value)}>
              <option value="All">All Leads</option>
              <option value="Action Required">Action Required</option>
              <option value="Call Requested">Call Requested</option>
              <option value="Pending Follow-up">Pending Follow-up</option>
              <option value="Ready for CRM">Ready for CRM</option>
            </select>

            <select className="search-field" style={{ width: '150px', height: '44px' }} value={selectedCity || 'All'} onChange={e => setSelectedCity(e.target.value === 'All' ? null : e.target.value)}>
              <option value="All">All Cities</option>
              {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            <div style={{ height: '24px', width: '1px', background: 'var(--border)', margin: '0 8px' }} />

            <button className="btn-primary" style={{ background: 'var(--success)' }} onClick={handleAutoPush} disabled={isAutoPushing || filteredLeads.length === 0}>
              <Zap size={16} /> {isAutoPushing ? 'Processing...' : 'Push to CRM'}
            </button>

            <button className="btn-primary" style={{ background: 'var(--glass-bg)', color: 'var(--text-main)', border: '1px solid var(--glass-border)' }} onClick={handleBulkExport} disabled={isExporting || filteredLeads.length === 0}>
              <Download size={16} /> Export
            </button>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
               <span style={{ fontSize: '0.85rem', fontWeight: '700', color: 'var(--primary)' }}>{filteredLeads.length} Sales Opportunities</span>
            </div>
          </div>

          {(dashboardFilter || searchPhone || selectedIntent || selectedStatus || selectedCity) && (
            <div className="fade-in active-filter-bar" style={{ 
              background: 'rgba(59, 130, 246, 0.1)', 
              border: '1px solid var(--primary)',
              padding: '16px 24px',
              borderRadius: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '32px'
            }}>
               <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                 <div style={{ background: 'var(--primary)', padding: '8px', borderRadius: '8px' }}>
                   <Filter size={18} color="#fff" />
                 </div>
                 <div>
                   <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Filters</div>
                   <div style={{ fontSize: '1rem', fontWeight: '800', color: 'var(--text-main)' }}>
                     {dashboardFilter?.label || 'Custom View'} {(searchPhone || selectedIntent || selectedStatus || selectedCity) ? ' (Search/Dropdowns Active)' : ''}
                   </div>
                 </div>
               </div>
               <button className="clear-filter-btn" onClick={() => {
                 setDashboardFilter(null);
                 setSearchPhone('');
                 setSelectedIntent(null);
                 setSelectedStatus(null);
                 setSelectedCity(null);
                 setActiveChartFilter(null);
               }} style={{ padding: '10px 20px', fontSize: '0.85rem' }}>
                 <X size={16} /> Clear All Filters
               </button>
            </div>
          )}

      {autoPushStatus && (
        <div className="glass-panel fade-in" style={{ padding: '12px 20px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: `4px solid ${autoPushStatus.processing ? COLORS.primary : COLORS.success}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {autoPushStatus.processing ? <RefreshCcw size={16} className="spin" /> : <CheckCircle size={16} color={COLORS.success} />}
            <span style={{ fontWeight: '700' }}>
              {autoPushStatus.processing ? `Processing ${autoPushStatus.total} leads...` : `Automation Complete: ${autoPushStatus.success} Success, ${autoPushStatus.failed} Failed`}
            </span>
          </div>
          <button className="btn-icon" onClick={() => setAutoPushStatus(null)}><X size={16} /></button>
        </div>
      )}

          <div style={{ overflowX: 'auto' }}>
            <table className="lead-table">
              <thead>
                <tr>
                  <th style={{ width: '80px' }}>Wait</th>
                  <th>Lead Details</th>
                  <th>City</th>
                  <th>Priority</th>
                  <th>Intent Focus</th>
                  <th>Call Req</th>
                  <th>Last Activity</th>
                  <th style={{ width: '150px' }}>Actions</th>
                </tr>
              </thead>
              <tbody style={{ borderCollapse: 'separate', borderSpacing: '0 8px' }}>
                {filteredLeads.length === 0 ? (
                  <tr>
                    <td colSpan="9" style={{ textAlign: 'center', padding: '120px 0', border: 'none' }}>
                      <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <div style={{ fontSize: '3.5rem', filter: 'grayscale(1)', opacity: 0.3 }}>🕵️</div>
                        <div style={{ fontSize: '1.25rem', fontWeight: '800', color: 'var(--text-main)' }}>No leads in this category</div>
                        <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', maxWidth: '300px' }}>
                          We couldn't find any leads matching the current filter. Try clearing the filter or searching again.
                        </div>
                        <button className="btn-primary" onClick={clearDashboardFilter} style={{ background: 'var(--glass-bg)', height: '40px', padding: '0 20px', fontSize: '0.8rem' }}>
                          Reset All Filters
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredLeads.map(l => (
                    <tr 
                      key={l.id} 
                      className={`lead-row ${l._intent.label.includes('HOT') ? 'glow-hot' : ''} ${l.isOverdue ? 'overdue-highlight' : ''}`} 
                      onClick={() => { setSelectedLead(l); setIsPanelOpen(true); }}
                    >
                      <td style={{ color: l._sla.color, fontWeight: '900' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {l.isOverdue && <AlertCircle size={14} color="var(--danger)" />}
                          {l._sla.text}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: '800', fontSize: '1.05rem' }}>{l.contact_name || 'Anonymous'}</div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '2px' }}>{l.phone_number}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: '700' }}>{l.city || 'Unknown'}</div>
                      </td>
                      <td>
                        <span style={{ 
                          padding: '4px 10px', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '900',
                          background: l._intent.label.includes('HOT') ? 'rgba(239, 68, 68, 0.15)' : l._intent.label.includes('WARM') ? 'rgba(245, 158, 11, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: l._intent.label.includes('HOT') ? 'var(--hot)' : l._intent.label.includes('WARM') ? 'var(--warm)' : 'var(--cold)',
                          border: `1px solid currentColor`
                        }}>
                          {l._intent.label}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {l.interest_cost && <span style={{ fontSize: '0.65rem', background: 'var(--glass-bg)', padding: '2px 6px', borderRadius: '4px' }}>Cost</span>}
                          {l.interest_recovery && <span style={{ fontSize: '0.65rem', background: 'var(--glass-bg)', padding: '2px 6px', borderRadius: '4px' }}>Recovery</span>}
                          {l.concern_pain && <span style={{ fontSize: '0.65rem', background: 'var(--glass-bg)', padding: '2px 6px', borderRadius: '4px' }}>Pain</span>}
                          {(!l.interest_cost && !l.interest_recovery && !l.concern_pain) && <span style={{ color: 'var(--text-muted)' }}>-</span>}
                        </div>
                      </td>
                      <td>
                        {l.request_call ? <span className="blink-call" style={{ color: 'var(--hot)', fontWeight: '900' }}>📞 YES</span> : <span style={{ opacity: 0.2 }}>-</span>}
                      </td>
                      <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        {formatDistanceToNow(parseISO(l.created_at))} ago
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }} onClick={e => e.stopPropagation()}>
                          <button className="btn-icon" title="Call Now" onClick={() => window.open(`tel:${l.phone_number}`)} style={{ color: 'var(--success)' }}><Phone size={14} /></button>
                          <button className="btn-icon" title="WhatsApp" onClick={() => window.open(`https://wa.me/${l.phone_number.replace(/\+/g, '')}`)} style={{ color: '#25D366' }}><MessageSquare size={14} /></button>
                          <button className="btn-icon" title="Sync to CRM" onClick={() => handleAutoPush()} style={{ color: 'var(--accent)' }}><Zap size={14} /></button>
                          <button className="btn-icon" title="Archive Lead" onClick={() => { if(window.confirm('Archive this lead?')) handleUpdateLead(l.id, { status: 'lost' }); }} style={{ color: 'var(--danger)' }}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      )}

      {isPanelOpen && selectedLead && (
        <div className="glass-panel fade-in" style={{
          position: 'fixed', right: 0, top: 0, height: '100%', width: '640px',
          background: 'var(--panel-bg)', zIndex: 1000, boxShadow: '-25px 0 60px rgba(0,0,0,0.5)',
          padding: '40px', overflowY: 'auto', borderLeft: '3px solid var(--primary)',
          backdropFilter: 'blur(20px)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
              <div style={{ width: '64px', height: '64px', background: 'var(--glass-bg)', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--glass-border)' }}>
                <User size={32} color="var(--primary)" />
              </div>
              <div>
                <h2 style={{ fontSize: '2rem', fontWeight: '900', letterSpacing: '-0.02em' }}>{selectedLead.contact_name || 'Lead Details'}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: '600', marginTop: '4px' }}>
                   {selectedLead.phone_number} • {formatDistanceToNow(parseISO(selectedLead.created_at))} ago
                </div>
              </div>
            </div>
            <button className="btn-icon" onClick={() => setIsPanelOpen(false)} style={{ padding: '12px', background: 'var(--glass-bg)' }}><X size={32} /></button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            <section>
              <h3 style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <MapPin size={14} /> Profile Information
              </h3>
              <div className="glass-panel" style={{ padding: '24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                {[
                  { label: 'Name', value: selectedLead.contact_name },
                  { label: 'City', value: selectedLead.city },
                  { label: 'Insurance', value: selectedLead.insurance },
                  { label: 'Contact Type', value: selectedLead.is_returning ? 'Returning User 👋' : 'New Lead' },
                  { label: 'Timeline', value: selectedLead.timeline },
                  { label: 'Source', value: selectedLead.source },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>{item.label}</div>
                    <div style={{ fontWeight: '700', color: 'var(--text-main)', fontSize: '1rem' }}>{item.value || 'Not provided'}</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <Activity size={14} /> Lead Intelligence
              </h3>
              <div className="glass-panel" style={{ padding: '24px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
                  <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>Urgency Level</div>
                    <div style={{ fontWeight: '800', color: selectedLead.urgency_level === 'high' ? 'var(--hot)' : 'var(--text-main)' }}>
                      {selectedLead.urgency_level?.toUpperCase() || 'UNKNOWN'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>Intent Score</div>
                    <div style={{ fontWeight: '800' }}>{selectedLead.intent_score || '0'}/100</div>
                  </div>
                </div>
                
                <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px' }}>Interests & Concerns</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ padding: '6px 12px', borderRadius: '8px', background: selectedLead.interest_cost ? 'rgba(59, 130, 246, 0.1)' : 'var(--glass-bg)', fontSize: '0.8rem', opacity: selectedLead.interest_cost ? 1 : 0.4 }}>💰 Cost</span>
                  <span style={{ padding: '6px 12px', borderRadius: '8px', background: selectedLead.interest_recovery ? 'rgba(59, 130, 246, 0.1)' : 'var(--glass-bg)', fontSize: '0.8rem', opacity: selectedLead.interest_recovery ? 1 : 0.4 }}>⏱️ Recovery</span>
                  <span style={{ padding: '6px 12px', borderRadius: '8px', background: selectedLead.concern_pain ? 'rgba(239, 68, 68, 0.1)' : 'var(--glass-bg)', fontSize: '0.8rem', opacity: selectedLead.concern_pain ? 1 : 0.4 }}>💉 Pain</span>
                  <span style={{ padding: '6px 12px', borderRadius: '8px', background: selectedLead.concern_safety ? 'rgba(239, 68, 68, 0.1)' : 'var(--glass-bg)', fontSize: '0.8rem', opacity: selectedLead.concern_safety ? 1 : 0.4 }}>🛡️ Safety</span>
                </div>
              </div>
            </section>

            <section>
              <h3 style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <MessageSquare size={14} /> Intelligence Context
              </h3>
              <div className="glass-panel" style={{ padding: '24px' }}>
                <div style={{ marginBottom: '24px' }}>
                  <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px' }}>Last User Message</div>
                  <div style={{ padding: '20px', background: 'var(--bg-dark)', borderRadius: '16px', fontStyle: 'italic', border: '1px solid var(--border)', fontSize: '0.95rem', lineHeight: '1.6' }}>
                    "{selectedLead.last_user_message || 'Waiting for interaction data...'}"
                  </div>
                </div>
                {selectedLead.user_questions && (
                  <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px' }}>Open Questions</div>
                    <div style={{ fontSize: '1rem', color: 'var(--text-main)', fontWeight: '600' }}>{selectedLead.user_questions}</div>
                  </div>
                )}
              </div>
            </section>

            <section>
               <h3 style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <Activity size={14} /> Workflow & Lifecycle
              </h3>
              <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                   <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Assign Representative</div>
                    <select className="search-field" style={{ width: '100%', height: '48px' }} value={selectedLead.assignee || ''} onChange={e => handleUpdateLead(selectedLead.id, { assignee: e.target.value })}>
                      <option value="">Unassigned</option>
                      {REPS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Pipeline Status</div>
                    <select className="search-field" style={{ width: '100%', height: '48px' }} value={selectedLead.status} onChange={e => handleUpdateLead(selectedLead.id, { status: e.target.value })}>
                      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '16px' }}>
                  <button className="btn-primary" style={{ flex: 1, height: '52px', fontSize: '1.05rem' }} onClick={handleAutoPush}>
                    <Zap size={20} /> Sync with CRM
                  </button>
                  <button className="btn-primary" style={{ background: 'var(--glass-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', flex: 1, height: '52px' }} onClick={() => { handleUpdateLead(selectedLead.id, { status: 'lost' }); setIsPanelOpen(false); }}>
                    Mark Inactive
                  </button>
                </div>
              </div>
            </section>

            <section style={{ marginBottom: '60px' }}>
              <h3 style={{ fontSize: '0.75rem', fontWeight: '800', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <History size={14} /> Internal Communication
              </h3>
              <div style={{ background: 'var(--glass-bg)', borderRadius: '20px', padding: '20px', border: '1px solid var(--border)' }}>
                <div style={{ maxHeight: '250px', overflowY: 'auto', marginBottom: '24px', fontSize: '0.85rem', whiteSpace: 'pre-line', lineHeight: '1.7', color: 'var(--text-main)', padding: '4px' }}>
                  {selectedLead.remarks || 'No internal history for this record.'}
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <input id="remark-input-panel" type="text" placeholder="Update record notes..." className="search-field" style={{ flex: 1, height: '52px' }} onKeyPress={e => {
                    if (e.key === 'Enter') {
                      appendRemark(selectedLead.id, selectedLead.remarks, e.target.value);
                      e.target.value = '';
                    }
                  }} />
                  <button className="btn-primary" style={{ borderRadius: '16px', width: '52px', height: '52px', padding: 0, justifyContent: 'center' }} onClick={() => {
                    const val = document.getElementById('remark-input-panel').value;
                    appendRemark(selectedLead.id, selectedLead.remarks, val);
                    document.getElementById('remark-input-panel').value = '';
                  }}><Send size={20} /></button>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
