import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './lib/supabase';
import {
  Zap, Clock, Target, User, AlertTriangle, Search, Filter,
  ChevronRight, MoreVertical, MessageSquare, Send, CheckCircle,
  RefreshCcw, Calendar, TrendingUp, Users, MapPin, ExternalLink,
  Download, X, Phone, Bot, History, Activity, Globe
} from 'lucide-react';
import { formatDistanceToNow, parseISO, differenceInMinutes, startOfDay, isWithinInterval, subDays, subMinutes, subHours } from 'date-fns';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';
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
  return { label: 'WARM', class: 'intent-warm' };
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
  const [leads, setLeads] = useState([]);
  const [metricsData, setMetricsData] = useState([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // 10s refresh

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
    const [leadsRes, metricsRes] = await Promise.all([
      supabase.from('leads_surgery').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('dashboard_metrics').select('*')
    ]);

    if (!leadsRes.error) setLeads(leadsRes.data);
    if (!metricsRes.error) setMetricsData(metricsRes.data);
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

  const enrichedLeads = useMemo(() => {
    return leads.map(l => ({
      ...l,
      _intent: getTargetIntent(l),
      _sla: getSLAStyle(l.created_at)
    }));
  }, [leads]);

  const filteredLeads = useMemo(() => {
    return enrichedLeads.filter(l => {
      const matchesPhone = !searchPhone || l.phone_number?.includes(searchPhone);
      const matchesStatus = !selectedStatus || l.status === selectedStatus;
      const matchesCity = !selectedCity || l.city === selectedCity;
      const matchesIntent = !selectedIntent || l._intent.label.includes(selectedIntent.toUpperCase());

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

      return matchesPhone && matchesStatus && matchesCity && matchesIntent && matchesDate && matchesChart;
    });
  }, [enrichedLeads, searchPhone, selectedCity, selectedIntent, selectedStatus, selectedTime, activeChartFilter]);

  // Metrics derived from dashboard_metrics view
  const summaryMetrics = useMemo(() => {
    const today = startOfDay(new Date());
    return {
      last30m: enrichedLeads.filter(l => l._sla.minutes <= 30).length,
      last1h: enrichedLeads.filter(l => l._sla.minutes <= 60).length,
      today: enrichedLeads.filter(l => l.created_at && parseISO(l.created_at) >= today).length,
      unassigned: enrichedLeads.filter(l => !l.assignee).length,
      slaBreaches: metricsData.filter(m => m.sla_bucket === 'Breached').length
    };
  }, [enrichedLeads, metricsData]);

  const transformMetricsData = (key) => {
    const counts = {};
    metricsData.forEach(item => {
      const val = item[key] || 'Unknown';
      counts[val] = (counts[val] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  };

  const chartData = useMemo(() => ({
    freshness: transformMetricsData('freshness_bucket').map(d => ({
      ...d,
      fill: d.name === '0-30m' ? '#10b981' : d.name === '30-60m' ? '#34d399' : d.name === '1-6h' ? '#f59e0b' : d.name === '6-24h' ? '#f97316' : '#ef4444'
    })),
    sla: transformMetricsData('sla_bucket').map(d => ({
      ...d,
      fill: d.name === 'Within' ? '#10b981' : d.name === 'Approaching' ? '#f59e0b' : '#ef4444'
    })),
    intent: transformMetricsData('intent_level').map(d => ({
      ...d,
      name: d.name.toUpperCase(),
      fill: d.name === 'hot' ? '#f43f5e' : d.name === 'warm' ? '#f59e0b' : '#818cf8'
    })),
    source: transformMetricsData('source'),
    status: transformMetricsData('status')
  }), [metricsData]);

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

  const runSimulation = async (type) => {
    let leadData = {
      phone_number: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
      contact_name: 'Simulated Lead',
      city: 'Mumbai',
      source: 'chatbot',
      lead_type: 'surgery',
      last_user_message: 'I want to know about LASIK costs.',
      user_questions: 'How much does it cost?',
      bot_fallback: false
    };

    if (type === 'HOT') {
      leadData = {
        ...leadData,
        contact_name: 'Simulated HOT 🔥',
        insurance: 'ICICI Lombard',
        preferred_surgery_city: 'Mumbai',
        timeline: 'Immediate',
        last_user_message: 'Yes, I want to book now.'
      };
    } else if (type === 'WARM') {
      leadData = {
        ...leadData,
        contact_name: 'Simulated WARM',
        insurance: 'None',
        last_user_message: 'Just looking for options.'
      };
    } else if (type === 'REFERRAL') {
      leadData = {
        ...leadData,
        contact_name: 'Simulated REFERRAL',
        lead_type: 'referral',
        last_user_message: 'Referred by Dr. Sharma.'
      };
    } else if (type === 'FALLBACK') {
      leadData = {
        ...leadData,
        contact_name: 'Simulated FALLBACK',
        bot_fallback: true,
        last_user_message: 'Askdhjaksd'
      };
    }

    try {
      setLoading(true);
      await ingestLead(leadData);
      fetchData();
    } catch (err) {
      alert('Simulation failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="command-center" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'white' }}>Establishing Connection...</div>;

  return (
    <div className="command-center fade-in">
      <header style={{ marginBottom: '32px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: COLORS.primary, marginBottom: '4px' }}>
            <Zap size={18} fill="currentColor" />
            <span style={{ fontWeight: '800', letterSpacing: '0.1em', fontSize: '0.75rem', textTransform: 'uppercase' }}>Live Arrival Sync</span>
          </div>
          <h1 style={{ fontSize: '2.5rem', fontWeight: '900', letterSpacing: '-0.02em', color: 'white' }}>
            Lead Arrival <span style={{ color: COLORS.primary }}>Control Center</span>
          </h1>
        </div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: '800', opacity: 0.6 }}>BOT SIM:</span>
            <button className="btn-icon" title="Simulate HOT" onClick={() => runSimulation('HOT')} style={{ color: COLORS.danger }}><Target size={14} /></button>
            <button className="btn-icon" title="Simulate WARM" onClick={() => runSimulation('WARM')} style={{ color: COLORS.warning }}><Activity size={14} /></button>
            <button className="btn-icon" title="Simulate REFERRAL" onClick={() => runSimulation('REFERRAL')} style={{ color: COLORS.indigo }}><Globe size={14} /></button>
            <button className="btn-icon" title="Simulate FALLBACK" onClick={() => runSimulation('FALLBACK')} style={{ color: COLORS.slate }}><Bot size={14} /></button>
          </div>
          <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="dot active pulse-primary" />
            <span style={{ fontSize: '0.75rem', fontWeight: '700' }}>SYSREFIX: 10s</span>
          </div>
          <button className="btn-icon" onClick={fetchData}><RefreshCcw size={18} /></button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '32px' }}>
        {[
          { label: 'Leads 30m', value: summaryMetrics.last30m, icon: <Clock size={16} /> },
          { label: 'Leads 1h', value: summaryMetrics.last1h, icon: <Clock size={16} /> },
          { label: 'Leads Today', value: summaryMetrics.today, icon: <Calendar size={16} />, color: COLORS.success },
          { label: 'Unassigned', value: summaryMetrics.unassigned, icon: <User size={16} />, color: COLORS.warning },
          { label: 'SLA Breaches', value: summaryMetrics.slaBreaches, icon: <AlertTriangle size={16} />, color: COLORS.danger }
        ].map(m => (
          <div key={m.label} className="glass-panel metric-card">
            <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>{m.icon} {m.label}</span>
            <span className="metric-value" style={{ color: m.color || 'white' }}>{m.value}</span>
          </div>
        ))}
      </div>

      <div className="charts-grid">
        {[
          { title: 'Lead Freshness', key: 'freshness', data: chartData.freshness },
          { title: 'SLA Status', key: 'sla', data: chartData.sla },
          { title: 'Lead Intent', key: 'intent', data: chartData.intent },
          { title: 'Source', key: 'source', data: chartData.source },
          { title: 'Status Pipeline', key: 'status', data: chartData.status }
        ].map(c => (
          <div key={c.title} className="glass-panel chart-container">
            <span className="chart-title">{c.title}</span>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={c.data}
                  innerRadius={55}
                  outerRadius={75}
                  paddingAngle={5}
                  dataKey="value"
                  onClick={(data) => toggleChartFilter(c.key, data.name)}
                  cursor="pointer"
                >
                  {c.data.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.fill || Object.values(COLORS)[index % 8]}
                      stroke="rgba(0,0,0,0)"
                      opacity={activeChartFilter?.key === c.key && activeChartFilter?.value !== entry.name ? 0.3 : 1}
                    />
                  ))}
                </Pie>
                <RechartsTooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>

      <div className="glass-panel" style={{ padding: '16px', marginBottom: '16px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
        <div style={{ position: 'relative', width: '180px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search phone..."
            className="search-field"
            style={{ paddingLeft: '36px', height: '38px', width: '100%' }}
            value={searchPhone}
            onChange={e => setSearchPhone(e.target.value)}
          />
        </div>

        <select 
          className="search-field" 
          style={{ height: '38px', width: '140px', padding: '0 12px' }}
          value={selectedCity || 'All'}
          onChange={e => setSelectedCity(e.target.value === 'All' ? null : e.target.value)}
        >
          <option value="All">All Cities</option>
          <option value="Mumbai">Mumbai</option>
          <option value="Pune">Pune</option>
          <option value="Surat">Surat</option>
          <option value="Nagpur">Nagpur</option>
        </select>

        <select 
          className="search-field" 
          style={{ height: '38px', width: '140px', padding: '0 12px' }}
          value={selectedIntent || 'All'}
          onChange={e => setSelectedIntent(e.target.value === 'All' ? null : e.target.value)}
        >
          <option value="All">All Intent</option>
          <option value="HOT">HOT</option>
          <option value="WARM">WARM</option>
          <option value="REFERRAL">REFERRAL</option>
        </select>

        <select 
          className="search-field" 
          style={{ height: '38px', width: '140px', padding: '0 12px' }}
          value={selectedStatus || 'All'}
          onChange={e => setSelectedStatus(e.target.value === 'All' ? null : e.target.value)}
        >
          <option value="All">All Status</option>
          <option value="NEW">NEW</option>
          <option value="PUSHED_TO_CRM">PUSHED_TO_CRM</option>
        </select>

        <select 
          className="search-field" 
          style={{ height: '38px', width: '160px', padding: '0 12px' }}
          value={selectedTime}
          onChange={e => setSelectedTime(e.target.value)}
        >
          <option value="All">All Time</option>
          <option value="Last 30 min">Last 30 min</option>
          <option value="Last 1 hour">Last 1 hour</option>
          <option value="Today">Today</option>
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: '700', color: COLORS.primary }}>
            Showing {filteredLeads.length} filtered leads
          </span>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginLeft: 'auto' }}>
          <button
            className="btn-primary"
            style={{ background: COLORS.indigo, border: 'none', height: '38px', padding: '0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
            onClick={handleBulkAssign}
            disabled={filteredLeads.length === 0}
          >
            <Users size={14} />
            Set Assignee
          </button>

          <button
            className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '38px', padding: '0 16px', background: COLORS.success }}
            onClick={handleAutoPush}
            disabled={isAutoPushing || filteredLeads.length === 0}
          >
            <Zap size={14} />
            {isAutoPushing ? 'Processing...' : 'Push to CRM (Auto)'}
          </button>

          <button
            className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '38px', padding: '0 16px' }}
            onClick={handleBulkExport}
            disabled={isExporting || filteredLeads.length === 0}
          >
            <Download size={14} />
            Download CSV
          </button>
        </div>
      </div>

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
              <th>Time</th>
              <th>Contact Name</th>
              <th>Phone</th>
              <th>Location</th>
              <th>Intent</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>Params</th>
              <th>CRM</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.map(l => (
              <tr key={l.id} className="lead-row" onClick={() => { setSelectedLead(l); setIsPanelOpen(true); }}>
                <td style={{ color: l._sla.color, fontWeight: '700' }}>{l._sla.text}</td>
                <td style={{ fontWeight: '600' }}>{l.contact_name || 'Anonymous'}</td>
                <td>{l.phone_number}</td>
                <td>
                  <div>{l.city}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{l.preferred_surgery_city}</div>
                </td>
                <td className={l._intent.class}>{l._intent.label}</td>
                <td>
                  <span className="badge-outline" style={{ borderColor: l.status === 'lost' ? COLORS.danger : COLORS.primary }}>
                    {l.status}
                  </span>
                </td>
                <td>{l.assignee || <span style={{ opacity: 0.4 }}>Not Assigned</span>}</td>
                <td>
                  <div className="progress-dots">
                    {[1, 2, 3, 4].map(i => <div key={i} className={`dot ${i <= l.parameters_completed ? 'active' : ''}`} />)}
                  </div>
                </td>
                <td>
                  {l.pushed_to_crm ? <CheckCircle size={16} color={COLORS.success} /> : <div style={{ width: 16 }} />}
                </td>
                <td><button className="btn-icon"><MoreVertical size={16} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isPanelOpen && selectedLead && (
        <div className="glass-panel fade-in" style={{
          position: 'fixed', right: 0, top: 0, height: '100%', width: '580px',
          background: '#020617', zIndex: 1000, boxShadow: '-25px 0 60px rgba(0,0,0,0.8)',
          padding: '40px', overflowY: 'auto', borderLeft: '3px solid var(--primary)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div className="glass-panel" style={{ padding: '12px', background: 'var(--accent-glow)', borderRadius: '12px' }}>
                <User size={24} color="white" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.75rem', fontWeight: '900' }}>{selectedLead.contact_name || 'Lead Details'}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {selectedLead.phone_number} • {formatDistanceToNow(parseISO(selectedLead.created_at))} ago
                </div>
              </div>
            </div>
            <button className="btn-icon" onClick={() => setIsPanelOpen(false)} style={{ padding: '12px' }}><X size={24} /></button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

            <section>
              <h3 className="chart-title"><MapPin size={16} /> Lead Identity</h3>
              <div className="glass-panel" style={{ padding: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                {[
                  { label: 'Full Name', value: selectedLead.contact_name },
                  { label: 'Phone', value: selectedLead.phone_number },
                  { label: 'City', value: selectedLead.city },
                  { label: 'State', value: selectedLead.state },
                  { label: 'Country', value: selectedLead.country },
                  { label: 'Insurance', value: selectedLead.insurance },
                  { label: 'Surgery City', value: selectedLead.preferred_surgery_city },
                  { label: 'Timeline', value: selectedLead.timeline },
                  { label: 'Source', value: selectedLead.source },
                  { label: 'Created At', value: new Date(selectedLead.created_at).toLocaleString() }
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>{item.label}</div>
                    <div style={{ fontWeight: '600', color: 'white' }}>{item.value || '-'}</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="chart-title"><Bot size={16} /> Bot Interaction Details</h3>
              <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <div className="metric-label">Last User Message</div>
                  <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', fontStyle: 'italic', border: '1px solid rgba(255,255,255,0.05)' }}>
                    "{selectedLead.last_user_message || 'No direct messages captured.'}"
                  </div>
                </div>
                <div>
                  <div className="metric-label">User Questions</div>
                  <div style={{ color: 'white' }}>{selectedLead.user_questions || 'No unique questions recorded.'}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="metric-label">Bot Fallback Triggered</div>
                  <div style={{ color: selectedLead.bot_fallback ? COLORS.danger : COLORS.success, fontWeight: '800' }}>
                    {selectedLead.bot_fallback ? 'YES' : 'NO'}
                  </div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="chart-title"><Target size={16} /> Intent & Qualification</h3>
              <div className="glass-panel" style={{ padding: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <div className="metric-label">Intent Status</div>
                  <div className={selectedLead._intent.class} style={{ fontSize: '1.25rem', fontWeight: '900' }}>{selectedLead._intent.label}</div>
                </div>
                <div>
                  <div className="metric-label">Parameters Completed</div>
                  <div style={{ fontWeight: '800', fontSize: '1.25rem' }}>{selectedLead.parameters_completed} <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>/ 4</span></div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="chart-title"><CheckCircle size={16} /> CRM Status</h3>
              <div className="glass-panel" style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="metric-label">Pushed to CRM Flag</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {selectedLead.pushed_to_crm ? (
                    <><CheckCircle size={20} color={COLORS.success} /> <span style={{ fontWeight: '800', color: COLORS.success }}>INTERNAL RECORD SYNCED</span></>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontWeight: '600' }}>NOT PUSHED</span>
                  )}
                </div>
              </div>
            </section>

            <section>
              <h3 className="chart-title"><Activity size={16} /> Operations</h3>
              <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <div className="metric-label">Assignee</div>
                    <input
                      type="text"
                      className="search-field"
                      placeholder="Enter assignee name or phone..."
                      value={selectedLead.assignee || ''}
                      onChange={e => handleUpdateLead(selectedLead.id, { assignee: e.target.value })}
                    />
                  </div>
                  <div>
                    <div className="metric-label">Pipeline Status</div>
                    <select className="search-field" value={selectedLead.status} onChange={e => handleUpdateLead(selectedLead.id, { status: e.target.value })}>
                      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <button
                  className="btn-primary"
                  style={{ width: '100%', height: '44px', fontWeight: '700' }}
                  onClick={handleBulkExport}
                >
                  Push this Lead to CRM
                </button>
              </div>
            </section>

            <section style={{ marginBottom: '40px' }}>
              <h3 className="chart-title"><History size={16} /> Remarks Timeline</h3>
              <div className="glass-panel" style={{ padding: '16px', maxHeight: '200px', overflowY: 'auto', marginBottom: '16px', fontSize: '0.85rem', whiteSpace: 'pre-line', lineAlpha: 1.6 }}>
                {selectedLead.remarks || 'No interaction logs found.'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input id="remark-input" type="text" placeholder="Type internal note..." className="search-field" style={{ flex: 1 }} onKeyPress={e => {
                  if (e.key === 'Enter') {
                    appendRemark(selectedLead.id, selectedLead.remarks, e.target.value);
                    e.target.value = '';
                  }
                }} />
                <button className="btn-icon" style={{ borderRadius: '8px', width: '42px', height: '42px' }} onClick={() => {
                  const val = document.getElementById('remark-input').value;
                  appendRemark(selectedLead.id, selectedLead.remarks, val);
                  document.getElementById('remark-input').value = '';
                }}><Send size={18} /></button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
